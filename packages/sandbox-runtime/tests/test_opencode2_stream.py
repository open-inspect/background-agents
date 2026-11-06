"""OpenCode 2 prompt streaming, replayed from event streams recorded against OpenCode 2.2.5.

Each fixture under ``fixtures/opencode2`` is one real session's ``/api/event``
traffic (and its subagents'), with local paths replaced by ``/workspace``.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness.opencode2_stream import (
    OpenCode2PromptStream,
    bridge_tool_args,
    bridge_tool_name,
)
from sandbox_runtime.harness.opencode_client import SSEConnectionError, SSEStreamDisconnectedError

FIXTURES = Path(__file__).parent / "fixtures" / "opencode2"


def recorded(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (FIXTURES / f"{name}.jsonl").read_text().splitlines()]


def root_session(events: list[dict[str, Any]]) -> str:
    return next(
        e["data"]["sessionID"]
        for e in events
        if e["type"] == "session.created" and not e["data"].get("parentID")
    )


class FakeClient:
    def __init__(
        self,
        events: list[dict[str, Any]],
        *,
        disconnect_after: int | None = None,
        messages: list[dict[str, Any]] | None = None,
        variants: dict[tuple[str, str], list[str]] | None = None,
    ) -> None:
        self._events = events
        self._disconnect_after = disconnect_after
        self._messages = messages or []
        self._variants = variants or {}
        self.prompts: list[dict[str, Any]] = []
        self.selected: list[dict[str, str]] = []
        self.stops: list[str] = []

    @asynccontextmanager
    async def events(self, *, inactivity_timeout_seconds: float):
        async def iterate():
            for index, event in enumerate(self._events):
                if self._disconnect_after is not None and index == self._disconnect_after:
                    raise SSEStreamDisconnectedError("subscriber overflow")
                yield event

        yield iterate()

    async def post_prompt(self, session_id: str, body: dict[str, Any]) -> None:
        self.prompts.append(body)

    async def model_variants(self, provider_id: str, model_id: str) -> list[str] | None:
        return self._variants.get((provider_id, model_id))

    async def select_model(self, session_id: str, model: dict[str, str]) -> None:
        self.selected.append(model)

    async def request_stop(self, session_id: str | None, *, reason: str) -> bool:
        self.stops.append(reason)
        return True

    async def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self._messages


def make_stream(client: FakeClient, attachment_parts: list[dict[str, Any]] | None = None):
    attachments = MagicMock()
    attachments.build_file_parts.return_value = attachment_parts or []
    return OpenCode2PromptStream(
        client=client,  # type: ignore[arg-type]
        attachment_processor=attachments,
        log=MagicMock(),
        sse_inactivity_timeout_seconds=120.0,
        prompt_max_duration_seconds=600.0,
        prompt_cleanup_timeout_seconds=5.0,
    )


async def run(stream: OpenCode2PromptStream, session_id: str, **kwargs: Any) -> list[dict]:
    return [
        event
        async for event in stream.stream_prompt(
            opencode_session_id=session_id, message_id="cp-msg", content="hi", **kwargs
        )
    ]


def of_type(events: list[dict], kind: str) -> list[dict]:
    return [e for e in events if e["type"] == kind]


async def test_shell_call_text_steps_and_title():
    fixture = recorded("shell_and_text")
    client = FakeClient(fixture)
    events = await run(make_stream(client), root_session(fixture))

    tools = of_type(events, "tool_call")
    assert [(t["tool"], t["status"]) for t in tools] == [("bash", "running"), ("bash", "completed")]
    assert tools[0]["args"] == {"command": "echo hello-oc2"}
    assert tools[1]["output"] == "hello-oc2\n"
    assert {t["callId"] for t in tools} == {"call_ff3a25711c1f41b895766062"}

    assert of_type(events, "token")[-1]["content"] == "done"
    assert len(of_type(events, "step_start")) == 2
    finishes = of_type(events, "step_finish")
    assert [f["reason"] for f in finishes] == ["tool-calls", "stop"]
    assert finishes[0]["tokens"]["input"] == 3698
    assert [f["stepId"] for f in finishes] == [s["stepId"] for s in of_type(events, "step_start")]
    assert not of_type(events, "error")
    # OpenCode names the session after the execution ends; the stream waits for it.
    assert of_type(events, "session_title") == [
        {"type": "session_title", "title": "Running echo hello-oc2 in bash"}
    ]


async def test_title_wait_is_bounded(monkeypatch):
    fixture = [e for e in recorded("shell_and_text") if e["type"] != "session.renamed"]
    monkeypatch.setattr(
        "sandbox_runtime.harness.opencode2_stream.SESSION_TITLE_GRACE_SECONDS", 0.05
    )

    class SlowClient(FakeClient):
        @asynccontextmanager
        async def events(self, *, inactivity_timeout_seconds: float):
            async def iterate():
                for event in self._events:
                    yield event
                await asyncio.sleep(3600)

            yield iterate()

    events = await run(make_stream(SlowClient(fixture)), root_session(fixture))
    assert not of_type(events, "session_title")
    assert of_type(events, "token")[-1]["content"] == "done"


async def test_subagent_activity_is_attributed_to_its_task_call():
    fixture = recorded("subagent")
    events = await run(make_stream(FakeClient(fixture)), root_session(fixture))
    child = next(
        e["data"]["sessionID"]
        for e in fixture
        if e["type"] == "session.created" and e["data"].get("parentID")
    )

    tasks = [e for e in of_type(events, "tool_call") if e["tool"] == "task"]
    assert tasks[-1]["status"] == "completed"
    assert tasks[-1]["childSessionId"] == child
    assert tasks[0]["args"]["subagent_type"] == "general"
    # The subagent's own steps are reported as subtask activity of that call.
    child_steps = [e for e in events if e.get("isSubtask")]
    assert child_steps
    assert {e["childSessionId"] for e in child_steps} == {child}
    assert {e["taskCallId"] for e in child_steps} == {tasks[0]["callId"]}
    # Child text is never forwarded as the parent's reply.
    assert all(not e.get("isSubtask") for e in of_type(events, "token"))


async def test_oi_mcp_tools_drop_their_server_prefix():
    fixture = recorded("oi_tool")
    events = await run(make_stream(FakeClient(fixture)), root_session(fixture))
    names = {e["tool"] for e in of_type(events, "tool_call")}
    assert "get-child-status" in names
    assert not any(name.startswith("oi_") for name in names)


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("provider_failure", "Model unavailable: nope/nope"),
        ("variant_failure", "Variant unavailable for opencode/big-pickle: bogus-effort"),
    ],
)
async def test_execution_failure_is_reported_once(name: str, message: str):
    fixture = recorded(name)
    events = await run(make_stream(FakeClient(fixture)), root_session(fixture))
    assert of_type(events, "error") == [{"type": "error", "error": message, "messageId": "cp-msg"}]


async def test_interrupted_turn_ends_without_an_error():
    fixture = recorded("interrupted")
    events = await run(make_stream(FakeClient(fixture)), root_session(fixture))
    assert of_type(events, "tool_call")[-1]["status"] == "error"
    assert of_type(events, "tool_call")[-1]["output"] == "Tool execution interrupted"
    assert of_type(events, "step_finish")[-1]["reason"] == "error"
    assert not of_type(events, "error")


async def test_other_sessions_events_are_ignored():
    shell = recorded("shell_and_text")
    failure = recorded("provider_failure")
    # Another session's failure interleaved into this prompt's stream.
    interleaved = shell[:5] + failure + shell[5:]
    events = await run(make_stream(FakeClient(interleaved)), root_session(shell))
    assert not of_type(events, "error")
    assert of_type(events, "token")[-1]["content"] == "done"


async def test_lost_stream_recovers_this_prompts_reply():
    fixture = recorded("shell_and_text")
    session_id = root_session(fixture)
    user_id = next(e["data"]["inboxID"] for e in fixture if e["type"] == "session.inbox.enqueued")
    newest_first = [
        {"id": "msg_c", "type": "assistant", "content": [{"type": "text", "text": "final answer"}]},
        {"id": "msg_b", "type": "assistant", "content": [{"type": "text", "text": "checking"}]},
        {"id": user_id, "type": "user", "text": "hi"},
        {"id": "msg_a", "type": "assistant", "content": [{"type": "text", "text": "old turn"}]},
    ]
    client = FakeClient(fixture, disconnect_after=6, messages=newest_first)
    events: list[dict] = []
    with pytest.raises(SSEConnectionError):
        async for event in make_stream(client).stream_prompt(
            opencode_session_id=session_id, message_id="cp-msg", content="hi"
        ):
            events.append(event)
    assert [e["content"] for e in of_type(events, "token")] == ["checking", "final answer"]


async def test_model_and_effort_are_applied_to_the_session_once():
    fixture = recorded("shell_and_text")
    client = FakeClient(fixture, variants={("anthropic", "claude-opus-5-5"): ["high", "max"]})
    stream = make_stream(client)
    session_id = root_session(fixture)
    await run(stream, session_id, model="anthropic/claude-opus-5-5", reasoning_effort="max")
    await run(stream, session_id, model="anthropic/claude-opus-5-5", reasoning_effort="max")
    assert client.selected == [
        {"providerID": "anthropic", "id": "claude-opus-5-5", "variant": "max"}
    ]


async def test_effort_without_a_variant_is_dropped():
    fixture = recorded("shell_and_text")
    client = FakeClient(fixture, variants={("openai", "gpt-6.1-sol"): ["low", "high"]})
    await run(
        make_stream(client),
        root_session(fixture),
        model="openai/gpt-6.1-sol",
        reasoning_effort="max",
    )
    assert client.selected == [{"providerID": "openai", "id": "gpt-6.1-sol"}]


async def test_prompt_carries_text_and_inline_files():
    fixture = recorded("shell_and_text")
    client = FakeClient(fixture)
    part = {
        "type": "file",
        "mime": "image/png",
        "filename": "a.png",
        "url": "data:image/png;base64,AA==",
    }
    await run(make_stream(client, [part]), root_session(fixture))
    assert client.prompts == [
        {"text": "hi", "files": [{"uri": "data:image/png;base64,AA==", "name": "a.png"}]}
    ]


@pytest.mark.parametrize(
    ("name", "expected"),
    [("shell", "bash"), ("subagent", "task"), ("oi_spawn-child", "spawn-child"), ("read", "read")],
)
def test_tool_names_keep_their_1x_spelling(name: str, expected: str):
    assert bridge_tool_name(name) == expected


def test_file_tools_expose_file_path():
    assert bridge_tool_args("edit", {"path": "a.py", "oldString": "x"}) == {
        "path": "a.py",
        "oldString": "x",
        "filePath": "a.py",
    }
