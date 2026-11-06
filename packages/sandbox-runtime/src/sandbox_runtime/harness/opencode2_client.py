"""HTTP/SSE transport for the local OpenCode 2 server (``/api``, Basic auth)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, ClassVar, Final
from urllib.parse import quote

import httpx

from ..opencode2_runtime import OPENCODE2_USERNAME
from .opencode_client import (
    EXECUTION_STOP_POLL_SECONDS,
    McpInitializationUnavailable,
    OpenCodeClient,
)

if TYPE_CHECKING:
    from ..log_config import StructuredLogger

API_PREFIX: Final = "/api"
_UNAVAILABLE_MCP_STATUSES: Final = frozenset({"failed", "needs_auth", "needs_client_registration"})


class OpenCode2Client(OpenCodeClient):
    """OpenCode 2's ``/api`` surface over the 1.x client's SSE transport.

    The endpoints differ from 1.x in shape as well as path: prompts carry only
    text and files (the model is a session setting), ``/interrupt`` replaces
    ``/abort``, and ``/session/active`` lists running sessions instead of
    every session's status.
    """

    EVENT_PATH: ClassVar[str] = f"{API_PREFIX}/event"

    def __init__(self, *, base_url: str, password: str, log: StructuredLogger, **kwargs: Any):
        super().__init__(base_url=base_url, log=log, **kwargs)
        self._password = password
        self._api = f"{base_url}{API_PREFIX}"

    def _client_options(self) -> dict[str, Any]:
        return {"auth": httpx.BasicAuth(OPENCODE2_USERNAME, self._password)}

    def _session_url(self, opencode_session_id: str, suffix: str = "") -> str:
        return f"{self._api}/session/{quote(opencode_session_id, safe='')}{suffix}"

    async def create_session(self) -> str | None:
        response = await self._client().post(f"{self._api}/session", json={})
        response.raise_for_status()
        session_id: str | None = response.json().get("data", {}).get("id")
        return session_id

    async def session_exists(self, opencode_session_id: str) -> bool:
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

    async def post_prompt(self, opencode_session_id: str, request_body: dict[str, Any]) -> None:
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
        if not opencode_session_id:
            return False
        try:
            await self._client().post(self._session_url(opencode_session_id, "/interrupt"))
            self._log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self._log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

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

    async def get_messages(self, opencode_session_id: str) -> list[Any] | None:
        response = await self._client().get(self._session_url(opencode_session_id, "/message"))
        if response.status_code != 200:
            self._log.warn("bridge.final_state_fetch_error", status_code=response.status_code)
            return None
        messages: list[Any] = response.json().get("data", [])
        return messages

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
