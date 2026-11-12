"""HTTP/SSE transport for the bundled local OpenCode server (``/api``, Basic auth)."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote

import httpx

from ..opencode_auth import OPENCODE_USERNAME

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from ..log_config import StructuredLogger

HTTP_CONNECT_TIMEOUT_SECONDS: Final = 30.0
OPENCODE_REQUEST_TIMEOUT_SECONDS: Final = 30.0
EXECUTION_STOP_POLL_SECONDS: Final = 0.1
# Recovery reads back at most this many pages of a session's messages.
MESSAGE_PAGES_MAX: Final = 20
API_PREFIX: Final = "/api"
_UNAVAILABLE_MCP_STATUSES: Final = frozenset({"failed", "needs_auth", "needs_client_registration"})


class SSEConnectionError(Exception):
    """Raised when SSE connection fails."""


class SSEStreamDisconnectedError(SSEConnectionError):
    """Raised when the SSE transport fails while connecting or mid-stream."""


class SSEInactivityTimeoutError(Exception):
    """Raised when no SSE data arrives within the inactivity deadline."""


class McpInitializationUnavailable(RuntimeError):
    """The native connect operation settled without an available connector."""


class OpenCodeClient:
    """HTTP/SSE transport for the local OpenCode server.

    Owns the server's base URL, credentials and every raw wire concern:
    session creation and lookup, the ``/api/event`` SSE stream and its frame
    parsing, prompts, interrupts and message state. Prompt-lifecycle policy
    (inactivity and max-duration values, request bodies, event translation)
    stays in ``OpenCodePromptStream``.

    Prompts carry only text and files: the model is a session setting.

    Owns its connection pool unless one is injected.
    """

    def __init__(
        self,
        *,
        base_url: str,
        password: str,
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
        connect_timeout_seconds: float = HTTP_CONNECT_TIMEOUT_SECONDS,
        request_timeout_seconds: float = OPENCODE_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._api = f"{base_url}{API_PREFIX}"
        self._password = password
        self._log = log
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._request_timeout_seconds = request_timeout_seconds

    async def aclose(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()

    def _client(self) -> httpx.AsyncClient:
        # Created on first request so constructing a bridge that never runs
        # (common in tests) does not leak an unclosed connection pool.
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    self._request_timeout_seconds,
                    connect=self._connect_timeout_seconds,
                ),
                **self._client_options(),
            )
        return self._http_client

    def _client_options(self) -> dict[str, Any]:
        """``httpx.AsyncClient`` options shared by every request: the credentials."""
        return {"auth": httpx.BasicAuth(OPENCODE_USERNAME, self._password)}

    def _session_url(self, opencode_session_id: str, suffix: str = "") -> str:
        return f"{self._api}/session/{quote(opencode_session_id, safe='')}{suffix}"

    async def set_mcp_connected(self, name: str, connected: bool) -> None:
        action = "connect" if connected else "disconnect"
        response = await self._client().post(
            f"{self._api}/experimental/mcp/{quote(name, safe='')}/{action}"
        )
        response.raise_for_status()
        listing = await self._client().get(f"{self._api}/mcp")
        listing.raise_for_status()
        actual = next(
            (
                (server.get("status") or {}).get("status")
                for server in listing.json().get("data", [])
                if server.get("name") == name
            ),
            None,
        )
        if connected:
            if actual in _UNAVAILABLE_MCP_STATUSES:
                raise McpInitializationUnavailable("Managed MCP initialization unavailable")
            if actual != "connected":
                raise RuntimeError("Managed MCP connect outcome is uncertain")
        elif actual != "disabled":
            raise RuntimeError("Managed MCP client did not confirm disconnection")

    async def create_session(self) -> str | None:
        """Create a new OpenCode session, returning its id."""
        response = await self._client().post(f"{self._api}/session", json={})
        response.raise_for_status()
        session_id: str | None = response.json().get("data", {}).get("id")
        return session_id

    async def session_exists(self, opencode_session_id: str) -> bool:
        """Whether OpenCode still knows the session (a 200 from its lookup)."""
        response = await self._client().get(self._session_url(opencode_session_id))
        return response.status_code == 200

    async def model_variants(self, provider_id: str, model_id: str) -> list[str] | None:
        """The model's reasoning variants; ``None`` when OpenCode does not list the model.

        ``/model`` lists only models whose provider has credentials.
        """
        response = await self._client().get(f"{self._api}/model")
        response.raise_for_status()
        for model in response.json().get("data", []):
            if model.get("providerID") == provider_id and model.get("id") == model_id:
                return [
                    str(variant.get("id"))
                    for variant in model.get("variants") or []
                    if isinstance(variant, dict) and variant.get("id")
                ]
        return None

    async def select_model(self, opencode_session_id: str, model: dict[str, str]) -> None:
        """Switch the session's model.

        OpenCode accepts any reference here; an unknown model or variant fails
        the next execution instead, with the reason in ``execution.failed``.
        """
        response = await self._client().post(
            self._session_url(opencode_session_id, "/model"), json={"model": model}
        )
        response.raise_for_status()

    @asynccontextmanager
    async def events(
        self, *, inactivity_timeout_seconds: float
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        """Open the ``/api/event`` SSE stream and hand back decoded event dicts.

        Owns the response lifecycle and the inactivity deadline: the deadline
        is armed before connecting, reset on every chunk received, and covers
        the caller's body for the lifetime of the context; expiry raises
        ``SSEInactivityTimeoutError``. A non-200 handshake raises
        ``SSEConnectionError``; httpx transport failures (while connecting or
        mid-stream) are translated into ``SSEStreamDisconnectedError``.
        """
        try:
            async with asyncio.timeout(inactivity_timeout_seconds) as timeout_ctx:
                async with self._client().stream(
                    "GET",
                    f"{self._api}/event",
                    timeout=httpx.Timeout(None, connect=self._connect_timeout_seconds, read=None),
                ) as response:
                    if response.status_code != 200:
                        raise SSEConnectionError(f"SSE connection failed: {response.status_code}")
                    yield self._decoded_events(response, timeout_ctx, inactivity_timeout_seconds)
        except TimeoutError:
            raise SSEInactivityTimeoutError(
                f"SSE stream inactive for {inactivity_timeout_seconds:.0f}s (no data received)."
            )
        except httpx.TransportError as e:
            self._log.error("bridge.sse_transport_error", exc=e)
            raise SSEStreamDisconnectedError(str(e)) from e

    async def post_prompt(self, opencode_session_id: str, request_body: dict[str, Any]) -> None:
        """Queue the prompt; the turn itself arrives on the SSE stream."""
        response = await self._client().post(
            self._session_url(opencode_session_id, "/prompt"), json=request_body
        )
        if response.status_code != 200:
            self._log.error(
                "bridge.prompt_request_error",
                status_code=response.status_code,
                error_body=response.text,
            )
            raise RuntimeError(f"Prompt failed: {response.status_code} - {response.text}")

    async def request_stop(self, opencode_session_id: str | None, *, reason: str) -> bool:
        """Best-effort interrupt of the session's running execution (saves LLM compute)."""
        if not opencode_session_id:
            return False
        try:
            await self._client().post(self._session_url(opencode_session_id, "/interrupt"))
            self._log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self._log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

    async def session_active(self, opencode_session_id: str) -> bool:
        """Whether the session has an execution running (listed in ``/session/active``)."""
        response = await self._client().get(f"{self._api}/session/active")
        response.raise_for_status()
        return opencode_session_id in (response.json().get("data") or {})

    async def wait_until_idle(self, *, timeout_seconds: float) -> bool:
        """Confirm no session in the server is running (an empty ``/session/active``)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(timeout_seconds, 0.0)
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            try:
                response = await self._client().get(
                    f"{self._api}/session/active",
                    timeout=min(self._request_timeout_seconds, remaining),
                )
                if response.status_code == 200 and not response.json().get("data"):
                    return True
            except Exception as error:
                self._log.warn("bridge.stop_status_error", exc=error)
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(EXECUTION_STOP_POLL_SECONDS, remaining))

    async def messages_after(self, opencode_session_id: str, message_id: str) -> list[Any] | None:
        """The session's messages newer than ``message_id``, newest first.

        Follows the listing's pages until ``message_id`` appears. ``None`` when
        it never does (the prompt was not delivered) or OpenCode rejects a fetch.
        """
        newer: list[Any] = []
        params: dict[str, str] = {"order": "desc"}
        for _ in range(MESSAGE_PAGES_MAX):
            response = await self._client().get(
                self._session_url(opencode_session_id, "/message"), params=params
            )
            if response.status_code != 200:
                self._log.warn("bridge.final_state_fetch_error", status_code=response.status_code)
                return None
            page = response.json()
            for message in page.get("data") or []:
                if isinstance(message, dict) and message.get("id") == message_id:
                    return newer
                newer.append(message)
            next_cursor = (page.get("cursor") or {}).get("next")
            if not next_cursor:
                return None
            params = {"cursor": next_cursor}
        return None

    async def _decoded_events(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
        inactivity_timeout_seconds: float | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode.

        SSE format:
            data: {"id": "...", "type": "...", "data": {...}}

            : heartbeat

        Events are separated by double newlines; comment lines are skipped.
        If timeout_ctx is provided, its deadline is reset to now plus
        ``inactivity_timeout_seconds`` on every chunk received.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            if timeout_ctx is not None and inactivity_timeout_seconds is not None:
                timeout_ctx.reschedule(
                    asyncio.get_running_loop().time() + inactivity_timeout_seconds
                )

            # Frames split on LF-LF only: the peer is the bundled localhost
            # OpenCode server (Bun/Hono), which emits LF-framed SSE. CRLF
            # framing is deliberately not handled.
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)

                # Parse the event lines
                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        # Handle both "data: {...}" and "data:{...}" formats
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)

                # Join multi-line data and parse JSON
                if data_lines:
                    try:
                        raw_data = "\n".join(data_lines)
                        event = json.loads(raw_data)
                        yield event
                    except json.JSONDecodeError as e:
                        self._log.debug("bridge.sse_parse_error", exc=e)
