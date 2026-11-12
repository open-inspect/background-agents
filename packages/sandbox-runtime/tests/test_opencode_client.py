"""The OpenCode ``/api`` client against a mocked server."""

from __future__ import annotations

import asyncio
import base64
import json
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.harness.opencode_client import (
    McpInitializationUnavailable,
    OpenCodeClient,
    SSEConnectionError,
    SSEInactivityTimeoutError,
    SSEStreamDisconnectedError,
)

BASE = "http://localhost:4096"


def make_client(handler) -> tuple[OpenCodeClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = OpenCodeClient(base_url=BASE, password="pw", log=MagicMock())
    # The client builds its own pool lazily; give it a mock transport with the same auth.
    client._http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(record), **client._client_options()
    )
    return client, seen


async def test_requests_carry_basic_auth_and_api_prefix():
    client, seen = make_client(lambda _r: httpx.Response(200, json={"data": {"id": "ses_1"}}))
    assert await client.create_session() == "ses_1"
    request = seen[0]
    assert request.url.path == "/api/session"
    assert request.headers["authorization"] == "Basic " + base64.b64encode(b"opencode:pw").decode()


async def test_prompt_select_model_and_interrupt_use_v2_routes():
    client, seen = make_client(
        lambda r: httpx.Response(204 if r.url.path.endswith("/model") else 200, json={})
    )
    await client.select_model("ses_1", {"providerID": "anthropic", "id": "claude-opus-5-5"})
    await client.post_prompt("ses_1", {"text": "hi"})
    assert await client.request_stop("ses_1", reason="command")
    assert [r.url.path for r in seen] == [
        "/api/session/ses_1/model",
        "/api/session/ses_1/prompt",
        "/api/session/ses_1/interrupt",
    ]
    assert json.loads(seen[0].content) == {
        "model": {"providerID": "anthropic", "id": "claude-opus-5-5"}
    }


async def test_rejected_prompt_raises_with_the_server_reason():
    client, _ = make_client(lambda _r: httpx.Response(409, text="busy"))
    with pytest.raises(RuntimeError, match="409 - busy"):
        await client.post_prompt("ses_1", {"text": "hi"})


async def test_model_variants_reads_the_listing():
    listing = {
        "data": [
            {
                "providerID": "anthropic",
                "id": "claude-opus-5-5",
                "variants": [{"id": "high"}, {"id": "max"}],
            },
            {"providerID": "opencode", "id": "big-pickle", "variants": []},
        ]
    }
    client, _ = make_client(lambda _r: httpx.Response(200, json=listing))
    assert await client.model_variants("anthropic", "claude-opus-5-5") == ["high", "max"]
    assert await client.model_variants("opencode", "big-pickle") == []
    assert await client.model_variants("openai", "gpt-6.1-sol") is None


async def test_idle_means_no_active_session():
    responses = iter([{"data": {"ses_1": {"type": "running"}}}, {"data": {}}])
    client, _ = make_client(lambda _r: httpx.Response(200, json=next(responses)))
    assert await client.wait_until_idle(timeout_seconds=2.0)


async def test_messages_after_follow_pages_to_the_user_message():
    pages = {
        None: {"data": [{"id": "msg_3"}, {"id": "msg_2"}], "cursor": {"next": "c1"}},
        "c1": {"data": [{"id": "msg_user"}, {"id": "msg_0"}], "cursor": {"next": "c2"}},
    }
    client, seen = make_client(
        lambda r: httpx.Response(200, json=pages[r.url.params.get("cursor")])
    )
    assert await client.messages_after("ses_1", "msg_user") == [{"id": "msg_3"}, {"id": "msg_2"}]
    assert seen[0].url.params["order"] == "desc"
    assert seen[1].url.params["cursor"] == "c1"
    assert "order" not in seen[1].url.params


async def test_messages_after_an_absent_message_is_none():
    client, _ = make_client(
        lambda _r: httpx.Response(200, json={"data": [{"id": "msg_1"}], "cursor": {"next": None}})
    )
    assert await client.messages_after("ses_1", "msg_user") is None


@pytest.mark.parametrize(
    ("connected", "status", "error"),
    [
        (True, "connected", None),
        (True, "needs_auth", McpInitializationUnavailable),
        (True, "pending", RuntimeError),
        (False, "disabled", None),
        (False, "connected", RuntimeError),
    ],
)
async def test_mcp_toggle_confirms_the_listed_status(connected, status, error):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(204)
        return httpx.Response(
            200, json={"data": [{"name": "linear", "status": {"status": status}}]}
        )

    client, seen = make_client(handler)
    if error is None:
        await client.set_mcp_connected("linear", connected)
    else:
        with pytest.raises(error):
            await client.set_mcp_connected("linear", connected)
    action = "connect" if connected else "disconnect"
    assert seen[0].url.path == f"/api/experimental/mcp/linear/{action}"


async def test_events_stream_from_api_event():
    body = (
        'data: {"type":"server.connected","data":{}}\n\n'
        ": heartbeat\n\n"
        'data: {"type":"session.execution.started","data":{"sessionID":"ses_1"}}\n\n'
    )
    client, seen = make_client(
        lambda _r: httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
    )
    async with client.events(inactivity_timeout_seconds=5.0) as events:
        received = [event["type"] async for event in events]
    assert received == ["server.connected", "session.execution.started"]
    assert seen[0].url.path == "/api/event"


async def test_session_active_reads_the_running_sessions():
    client, seen = make_client(
        lambda _r: httpx.Response(200, json={"data": {"ses_1": {"type": "running"}}})
    )
    assert await client.session_active("ses_1")
    assert not await client.session_active("ses_2")
    assert seen[0].url.path == "/api/session/active"


async def test_events_reassemble_a_frame_split_across_chunks():
    async def chunks():
        yield b'data: {"ty'
        yield b'pe":"session.execution.started","data":{}}\n'
        yield b"\n"

    client, _ = make_client(
        lambda _r: httpx.Response(
            200, content=chunks(), headers={"content-type": "text/event-stream"}
        )
    )
    async with client.events(inactivity_timeout_seconds=5.0) as events:
        received = [event["type"] async for event in events]
    assert received == ["session.execution.started"]


async def test_events_rejected_handshake_is_a_connection_error():
    client, _ = make_client(lambda _r: httpx.Response(401, text="unauthorized"))
    with pytest.raises(SSEConnectionError) as raised:
        async with client.events(inactivity_timeout_seconds=5.0):
            pass
    assert not isinstance(raised.value, SSEStreamDisconnectedError)


async def test_events_transport_failure_is_a_disconnect():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client, _ = make_client(handler)
    with pytest.raises(SSEStreamDisconnectedError):
        async with client.events(inactivity_timeout_seconds=5.0):
            pass


async def test_events_silence_is_an_inactivity_timeout():
    async def silent():
        yield b": heartbeat\n\n"
        await asyncio.Event().wait()

    client, _ = make_client(
        lambda _r: httpx.Response(
            200, content=silent(), headers={"content-type": "text/event-stream"}
        )
    )
    with pytest.raises(SSEInactivityTimeoutError):
        async with client.events(inactivity_timeout_seconds=0.2) as events:
            async for _event in events:
                pass
