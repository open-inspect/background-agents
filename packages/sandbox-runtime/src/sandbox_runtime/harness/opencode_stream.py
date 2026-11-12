"""OpenCode prompt streaming: translate ``/api/event`` into bridge events.

OpenCode reports a turn as granular session events. Each prompt runs as one
*execution* of the session,
opened by ``session.execution.started`` and closed by ``succeeded``,
``failed`` or ``interrupted``, so attribution needs no message-ID bookkeeping:
the bridge prompts one turn at a time, and every parent-session event between
the prompt and the execution's end belongs to it.

The bridge emits ``token``, ``tool_call``, ``step_start``, ``step_finish``,
``error``, ``session_title`` and ``context_compacted`` events, with tool names
and arguments mapped to the names the web UI and completion extractor know.
"""

from __future__ import annotations

import asyncio
import re
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Final

from .opencode_client import (
    SSEConnectionError,
    SSEInactivityTimeoutError,
    SSEStreamDisconnectedError,
)
from .tools import OI_TOOL_SERVER_NAME

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from ..attachment_processor import AttachmentProcessor, HydratedSessionAttachment
    from ..log_config import StructuredLogger
    from .opencode_client import OpenCodeClient

# Bridge events keep the tool names the web UI and completion extractor know.
_TOOL_NAMES: Final = {"shell": "bash", "subagent": "task"}
_OI_TOOL_PREFIX: Final = f"{OI_TOOL_SERVER_NAME}_"
# OpenCode's file tools take ``path``; the UI reads ``filePath``.
_PATH_ARG_TOOLS: Final = frozenset({"read", "edit", "write"})
# Providers whose models take the requested reasoning effort as an OpenCode
# variant. OpenCode Zen and Go route each model to its own SDK, but OpenCode
# derives the variants from the catalog either way.
VARIANT_REASONING_PROVIDERS: Final = frozenset(
    {"anthropic", "openai", "xai", "opencode", "opencode-go"}
)
# OpenCode names a session after its first execution ends. A short first
# turn finishes before the name exists, so the stream waits this long for it.
SESSION_TITLE_GRACE_SECONDS: Final = 3.0
OPENCODE_DEFAULT_TITLE_RE: Final = re.compile(
    r"^(new session|child session) - " r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$",
    re.IGNORECASE,
)


class _PromptMaxDurationTimeout(Exception):
    """The prompt's max-duration deadline expired."""


class _Outcome(Enum):
    CONTINUE = "continue"
    FINISHED = "finished"


def bridge_tool_name(name: str) -> str:
    if name.startswith(_OI_TOOL_PREFIX):
        return name[len(_OI_TOOL_PREFIX) :]
    return _TOOL_NAMES.get(name, name)


def bridge_tool_args(tool: str, args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        return {}
    normalized = dict(args)
    if tool in _PATH_ARG_TOOLS and "path" in normalized:
        normalized.setdefault("filePath", normalized["path"])
    if tool == "task" and "agent" in normalized:
        normalized.setdefault("subagent_type", normalized["agent"])
    return normalized


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(item.get("text", ""))
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    )


def _error_message(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("message") or error.get("type") or "Unknown error")
    return str(error) if error else "Unknown error"


@dataclass
class _ToolCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class _PromptState:
    opencode_session_id: str
    message_id: str
    start_time: float
    user_message_id: str | None = None
    texts: dict[str, str] = field(default_factory=dict)
    sent_texts: dict[str, str] = field(default_factory=dict)
    tools: dict[str, _ToolCall] = field(default_factory=dict)
    emitted_tool_states: set[tuple[str, str]] = field(default_factory=set)
    # Child session -> its parent session, for every descendant of this prompt.
    children: dict[str, str] = field(default_factory=dict)
    # Child session -> the parent ``subagent`` call that started it.
    child_calls: dict[str, str] = field(default_factory=dict)
    step_costs: dict[str, float] = field(default_factory=dict)
    emitted_error: bool = False

    def message_cost_usd(self) -> float:
        return sum(self.step_costs.values())


class OpenCodePromptStream:
    """One long-lived translator per bridge."""

    def __init__(
        self,
        *,
        client: OpenCodeClient,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        sse_inactivity_timeout_seconds: float,
        prompt_max_duration_seconds: float,
        prompt_cleanup_timeout_seconds: float,
    ) -> None:
        self._client = client
        self._attachment_processor = attachment_processor
        self._log = log
        self._sse_inactivity_timeout_seconds = sse_inactivity_timeout_seconds
        self._prompt_max_duration_seconds = prompt_max_duration_seconds
        self._prompt_cleanup_timeout_seconds = prompt_cleanup_timeout_seconds
        self._last_forwarded_session_title: str | None = None
        self._selected_models: dict[str, dict[str, str]] = {}
        # The post-execution wait for a title happens at most once per bridge.
        self._title_waited = False

    async def stream_prompt(
        self,
        *,
        opencode_session_id: str,
        message_id: str,
        content: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
        attachments: list[HydratedSessionAttachment] | None = None,
        max_duration_seconds: float | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        state = _PromptState(
            opencode_session_id=opencode_session_id,
            message_id=message_id,
            start_time=time.time(),
        )
        loop = asyncio.get_running_loop()
        max_duration = (
            self._prompt_max_duration_seconds
            if max_duration_seconds is None
            else max_duration_seconds
        )
        prompt_deadline = loop.time() + max_duration
        try:
            async with AsyncExitStack() as stack:
                try:
                    async with asyncio.timeout(prompt_deadline - loop.time()):
                        await self._settle_previous_execution(opencode_session_id)
                        await self._select_model(opencode_session_id, model, reasoning_effort)
                        events = await stack.enter_async_context(
                            self._client.events(
                                inactivity_timeout_seconds=self._sse_inactivity_timeout_seconds
                            )
                        )
                        await self._client.post_prompt(
                            opencode_session_id, self._prompt_body(content, attachments)
                        )
                except TimeoutError as error:
                    raise _PromptMaxDurationTimeout from error
                iterator = aiter(events)
                while True:
                    remaining = prompt_deadline - loop.time()
                    if remaining <= 0:
                        raise _PromptMaxDurationTimeout
                    try:
                        async with asyncio.timeout(remaining):
                            event = await anext(iterator)
                    except StopAsyncIteration:
                        break
                    except TimeoutError as error:
                        raise _PromptMaxDurationTimeout from error
                    outcome, translated = self.apply_event(state, event)
                    for bridge_event in translated:
                        yield bridge_event
                    if outcome is _Outcome.FINISHED:
                        if self._last_forwarded_session_title is None and not self._title_waited:
                            self._title_waited = True
                            title = await self._late_session_title(state, iterator)
                            if title:
                                yield title
                        return
                raise SSEStreamDisconnectedError("OpenCode closed the event stream")
        except _PromptMaxDurationTimeout:
            self._log.error(
                "bridge.prompt_max_duration_timeout",
                timeout_ms=int(max_duration * 1000),
                elapsed_ms=int((time.time() - state.start_time) * 1000),
                message_id=message_id,
            )
            recovered: list[dict[str, Any]] = []
            try:
                async with asyncio.timeout(self._prompt_cleanup_timeout_seconds):
                    await self._client.request_stop(
                        opencode_session_id, reason="prompt_max_duration_timeout"
                    )
                    recovered = await self._recover_final_text(state)
            except TimeoutError:
                self._log.error(
                    "bridge.prompt_timeout_cleanup_timeout",
                    timeout_ms=int(self._prompt_cleanup_timeout_seconds * 1000),
                    message_id=message_id,
                )
            for bridge_event in recovered:
                yield bridge_event
            raise RuntimeError(f"Prompt exceeded max duration of {max_duration:.0f}s.")
        except SSEInactivityTimeoutError:
            elapsed = time.time() - state.start_time
            self._log.error(
                "bridge.sse_inactivity_timeout",
                timeout_name="sse_inactivity",
                timeout_ms=int(self._sse_inactivity_timeout_seconds * 1000),
                elapsed_ms=int(elapsed * 1000),
                operation="bridge.sse",
                message_id=message_id,
            )
            await self._client.request_stop(opencode_session_id, reason="inactivity_timeout")
            for bridge_event in await self._recover_final_text(state):
                yield bridge_event
            raise RuntimeError(
                f"SSE stream inactive for {self._sse_inactivity_timeout_seconds:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )
        except SSEStreamDisconnectedError as error:
            # OpenCode drops a subscriber that falls behind its event buffer.
            for bridge_event in await self._recover_final_text(state):
                yield bridge_event
            raise SSEConnectionError(
                "OpenCode event stream disconnected before completion; "
                "partial output was preserved when available."
            ) from error

    async def _settle_previous_execution(self, opencode_session_id: str) -> None:
        """Interrupt an execution an earlier prompt left running, and wait until it stops.

        A prompt whose stream disconnected or timed out can leave its execution
        running. Its terminal event would otherwise end the next prompt's
        stream, and its output would be attributed to the next prompt.
        """
        if not await self._client.session_active(opencode_session_id):
            return
        self._log.warn("bridge.previous_execution_running")
        await self._client.request_stop(opencode_session_id, reason="previous_execution")
        if not await self._client.wait_until_idle(
            timeout_seconds=self._prompt_cleanup_timeout_seconds
        ):
            raise RuntimeError("The previous OpenCode execution did not stop")

    async def _late_session_title(
        self, state: _PromptState, iterator: AsyncIterator[dict[str, Any]]
    ) -> dict[str, str] | None:
        try:
            async with asyncio.timeout(SESSION_TITLE_GRACE_SECONDS):
                async for event in iterator:
                    data = event.get("data")
                    if (
                        event.get("type") == "session.renamed"
                        and isinstance(data, dict)
                        and data.get("sessionID") == state.opencode_session_id
                    ):
                        return self._session_title_event_once(data.get("title"))
        except (TimeoutError, SSEConnectionError, SSEInactivityTimeoutError):
            pass
        return None

    async def _select_model(
        self, opencode_session_id: str, model: str | None, reasoning_effort: str | None
    ) -> None:
        """Apply the prompt's model to the session; prompts carry none."""
        if not model:
            return
        provider_id, model_id = model.split("/", 1) if "/" in model else ("anthropic", model)
        selection = {"providerID": provider_id, "id": model_id}
        if reasoning_effort and provider_id in VARIANT_REASONING_PROVIDERS:
            # An effort the model has no variant for would fail the whole
            # turn, so it is dropped and the model's default applies.
            variants = await self._client.model_variants(provider_id, model_id)
            if variants is None or reasoning_effort in variants:
                selection["variant"] = reasoning_effort
            else:
                self._log.warn(
                    "opencode.variant_unavailable",
                    model=model,
                    reasoning_effort=reasoning_effort,
                    variants=variants,
                )
        if self._selected_models.get(opencode_session_id) == selection:
            return
        await self._client.select_model(opencode_session_id, selection)
        self._selected_models[opencode_session_id] = selection

    def _prompt_body(
        self, content: str, attachments: list[HydratedSessionAttachment] | None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"text": content}
        files = [
            {"uri": part["url"], "name": part["filename"]}
            for part in self._attachment_processor.build_file_parts(attachments)
        ]
        if files:
            body["files"] = files
        return body

    def apply_event(
        self, state: _PromptState, event: dict[str, Any]
    ) -> tuple[_Outcome, list[dict[str, Any]]]:
        """Translate one OpenCode event, mutating ``state``."""
        event_type = event.get("type")
        data = event.get("data")
        if not isinstance(event_type, str) or not isinstance(data, dict):
            return _Outcome.CONTINUE, []
        session_id = data.get("sessionID")
        parent = state.opencode_session_id

        if event_type == "session.created":
            child_parent = data.get("parentID")
            if session_id and (child_parent == parent or child_parent in state.children):
                state.children[session_id] = child_parent
                self._log.info("bridge.child_session_detected", child_session_id=session_id)
            return _Outcome.CONTINUE, []

        if session_id == parent:
            return self._apply_parent_event(state, event_type, data)
        if session_id in state.children:
            return _Outcome.CONTINUE, self._child_events(state, session_id, event_type, data)
        return _Outcome.CONTINUE, []

    def _apply_parent_event(
        self, state: _PromptState, event_type: str, data: dict[str, Any]
    ) -> tuple[_Outcome, list[dict[str, Any]]]:
        events: list[dict[str, Any]] = []
        match event_type:
            case "session.inbox.enqueued" if state.user_message_id is None:
                state.user_message_id = data.get("inboxID")
            case "session.step.started":
                events.append(
                    {
                        "type": "step_start",
                        "messageId": state.message_id,
                        "stepId": data.get("assistantMessageID", ""),
                    }
                )
            case "session.step.ended" | "session.step.failed":
                events.append(self._step_finish(state, data, failed=event_type.endswith("failed")))
            case "session.text.delta":
                key = self._text_key(data)
                state.texts[key] = state.texts.get(key, "") + str(data.get("delta", ""))
                events.extend(self._token(state, key))
            case "session.text.ended":
                key = self._text_key(data)
                state.texts[key] = str(data.get("text", ""))
                events.extend(self._token(state, key))
            case (
                "session.tool.called"
                | "session.tool.progress"
                | "session.tool.success"
                | "session.tool.failed"
                | "session.tool.input.started"
            ):
                events.extend(self._tool_events(state, event_type, data))
            case "session.renamed":
                title = self._session_title_event_once(data.get("title"))
                if title:
                    events.append(title)
            case "session.compaction.ended":
                self._log.info("bridge.session_compacted", message_id=state.message_id)
                events.append({"type": "context_compacted", "messageId": state.message_id})
            case "session.retry.scheduled":
                self._log.warn(
                    "bridge.opencode_retry_scheduled",
                    attempt=data.get("attempt"),
                    error_msg=_error_message(data.get("error")),
                )
            case "session.execution.succeeded":
                self._log_finished(state, "succeeded")
                return _Outcome.FINISHED, events
            case "session.execution.interrupted":
                self._log_finished(state, f"interrupted:{data.get('reason')}")
                return _Outcome.FINISHED, events
            case "session.execution.failed":
                error_msg = _error_message(data.get("error"))
                self._log.error("bridge.session_error", error_msg=error_msg)
                if not state.emitted_error:
                    state.emitted_error = True
                    events.append(
                        {"type": "error", "error": error_msg, "messageId": state.message_id}
                    )
                return _Outcome.FINISHED, events
        return _Outcome.CONTINUE, events

    def _child_events(
        self, state: _PromptState, child_id: str, event_type: str, data: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Tool calls, steps and failures from a subagent, marked as subtask activity."""
        if event_type in {"session.step.ended", "session.step.failed"}:
            events = [self._step_finish(state, data, failed=event_type.endswith("failed"))]
        elif event_type.startswith("session.tool."):
            events = self._tool_events(state, event_type, data)
        elif event_type == "session.execution.failed":
            events = [
                {
                    "type": "error",
                    "error": _error_message(data.get("error")),
                    "messageId": state.message_id,
                }
            ]
        else:
            return []
        task_call_id = self._root_call(state, child_id)
        for event in events:
            event["isSubtask"] = True
            event["childSessionId"] = child_id
            if task_call_id:
                event["taskCallId"] = task_call_id
        return events

    def _root_call(self, state: _PromptState, child_id: str) -> str | None:
        """The parent-session ``subagent`` call a (possibly nested) child descends from."""
        session = child_id
        while state.children.get(session) not in (None, state.opencode_session_id):
            session = state.children[session]
        return state.child_calls.get(session)

    def _tool_events(
        self, state: _PromptState, event_type: str, data: dict[str, Any]
    ) -> list[dict[str, Any]]:
        call_id = str(data.get("id", ""))
        if not call_id:
            return []
        if event_type == "session.tool.input.started":
            state.tools[call_id] = _ToolCall(bridge_tool_name(str(data.get("name", ""))))
            return []
        call = state.tools.setdefault(call_id, _ToolCall(""))
        output = ""
        match event_type:
            case "session.tool.called":
                call.args = bridge_tool_args(call.name, data.get("input"))
                status = "running"
            case "session.tool.progress":
                metadata = data.get("metadata")
                child_id = metadata.get("sessionID") if isinstance(metadata, dict) else None
                if call.name == "task" and isinstance(child_id, str) and child_id:
                    if child_id not in state.child_calls:
                        state.child_calls[child_id] = call_id
                        state.children.setdefault(child_id, state.opencode_session_id)
                        return [self._tool_call(state, call_id, call, "running", "", child_id)]
                return []
            case "session.tool.success":
                status, output = "completed", _content_text(data.get("content"))
            case _:
                status = "error"
                output = _error_message(data.get("error"))
        if (call_id, status) in state.emitted_tool_states:
            return []
        state.emitted_tool_states.add((call_id, status))
        child_id = next(
            (child for child, call in state.child_calls.items() if call == call_id), None
        )
        return [self._tool_call(state, call_id, call, status, output, child_id)]

    @staticmethod
    def _tool_call(
        state: _PromptState,
        call_id: str,
        call: _ToolCall,
        status: str,
        output: str,
        child_session_id: str | None,
    ) -> dict[str, Any]:
        event: dict[str, Any] = {
            "type": "tool_call",
            "tool": call.name,
            "args": call.args,
            "callId": call_id,
            "status": status,
            "output": output,
            "messageId": state.message_id,
        }
        if child_session_id:
            event["childSessionId"] = child_session_id
        return event

    @staticmethod
    def _step_finish(state: _PromptState, data: dict[str, Any], *, failed: bool) -> dict[str, Any]:
        step_id = str(data.get("assistantMessageID", ""))
        cost = data.get("cost")
        if isinstance(cost, int | float) and not isinstance(cost, bool):
            state.step_costs[step_id] = float(cost)
        event: dict[str, Any] = {
            "type": "step_finish",
            "messageId": state.message_id,
            "stepId": step_id,
            "messageCostUsd": state.message_cost_usd(),
        }
        if data.get("tokens") is not None:
            event["tokens"] = data["tokens"]
        reason = "error" if failed else data.get("finish")
        if reason is not None:
            event["reason"] = reason
        if cost is not None:
            event["cost"] = cost
        return event

    @staticmethod
    def _text_key(data: dict[str, Any]) -> str:
        return f"{data.get('assistantMessageID', '')}:{data.get('ordinal', 0)}"

    @staticmethod
    def _token(state: _PromptState, key: str) -> list[dict[str, Any]]:
        text = state.texts.get(key, "")
        if not text or text == state.sent_texts.get(key):
            return []
        state.sent_texts[key] = text
        return [{"type": "token", "content": text, "messageId": state.message_id, "partId": key}]

    def _session_title_event_once(self, title: object) -> dict[str, str] | None:
        if not isinstance(title, str):
            return None
        trimmed = title.strip()
        if not trimmed or OPENCODE_DEFAULT_TITLE_RE.match(trimmed):
            return None
        if trimmed == self._last_forwarded_session_title:
            return None
        self._last_forwarded_session_title = trimmed
        return {"type": "session_title", "title": trimmed}

    def _log_finished(self, state: _PromptState, outcome: str) -> None:
        self._log.debug(
            "bridge.execution_finished",
            outcome=outcome,
            elapsed_s=round(time.time() - state.start_time, 1),
        )

    async def _recover_final_text(self, state: _PromptState) -> list[dict[str, Any]]:
        """Re-read this prompt's assistant text after the event stream was lost.

        This prompt's assistant messages are the ones newer than its user
        message. Without that message in the session (the prompt was never
        delivered), nothing is recovered: older replies are not this prompt's.
        """
        if state.user_message_id is None:
            return []
        try:
            messages = await self._client.messages_after(
                state.opencode_session_id, state.user_message_id
            )
        except Exception as error:
            self._log.error("bridge.final_state_error", exc=error)
            return []
        replies = [
            message
            for message in messages or []
            if isinstance(message, dict) and message.get("type") == "assistant"
        ]
        events: list[dict[str, Any]] = []
        for message in reversed(replies):
            texts = [
                item
                for item in message.get("content") or []
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            for ordinal, item in enumerate(texts):
                key = f"{message.get('id', '')}:{ordinal}"
                text = str(item.get("text", ""))
                if len(text) > len(state.sent_texts.get(key, "")):
                    state.texts[key] = text
                    events.extend(self._token(state, key))
        return events
