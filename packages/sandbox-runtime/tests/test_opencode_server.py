"""The supervisor half of the OpenCode harness: configuration, staging and launch."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime import opencode_server
from sandbox_runtime.opencode_auth import OPENCODE_PASSWORD_ENV_VAR, ensure_server_password
from sandbox_runtime.opencode_server import OpenCodeServer
from sandbox_runtime.runtime_config import OpenCodeConfig

if TYPE_CHECKING:
    from pathlib import Path


def test_password_is_generated_once_and_shared_through_the_environment():
    environ: dict[str, str] = {}
    first = ensure_server_password(environ)
    assert len(first) >= 32
    assert environ[OPENCODE_PASSWORD_ENV_VAR] == first
    assert ensure_server_password(environ) == first


def make_server(tmp_path: Path, *, mcp_servers=(), has_repository=True) -> OpenCodeServer:
    config = OpenCodeConfig(
        provider="anthropic",
        model="claude-opus-5-5",
        mcp_servers=tuple(mcp_servers),
        has_repository=has_repository,
        workspace_path=tmp_path,
        session_id="sess-1",
    )
    return OpenCodeServer(config, asyncio.Event(), MagicMock(), MagicMock(), environ={})


def test_config_denies_code_mode_and_human_only_tools(tmp_path):
    config = make_server(tmp_path).build_config({})
    assert config["model"] == "anthropic/claude-opus-5-5"
    rules = config["permissions"]
    assert rules[0] == {"action": "*", "resource": "*", "effect": "allow"}
    denied = {rule["action"] for rule in rules if rule["effect"] == "deny"}
    assert {"execute", "question", "opencode_worktree_*", "opencode_session_move"} <= denied


def test_config_adds_the_oi_tool_server_beside_session_mcp_servers(tmp_path):
    server = make_server(tmp_path)
    config = server.build_config({"linear": {"type": "remote", "url": "https://mcp.linear.app"}})
    assert config["mcp"]["linear"] == {"type": "remote", "url": "https://mcp.linear.app"}
    oi = config["mcp"]["oi"]
    assert oi["type"] == "local"
    command = oi["command"]
    assert command[1:3] == ["-m", "sandbox_runtime.harness.oi_mcp_server"]
    assert command[command.index("--session-id") + 1] == "sess-1"
    assert "--has-repository" in command


def test_repo_less_sessions_tell_the_tool_server(tmp_path):
    command = make_server(tmp_path, has_repository=False).build_config({})["mcp"]["oi"]["command"]
    assert "--has-repository" not in command


@pytest.fixture
def launch(tmp_path, monkeypatch):
    """Run ``start`` with the image's plugins and a fake ``opencode serve``."""
    plugins = tmp_path / "plugins"
    plugins.mkdir()
    for name in (opencode_server.RUNTIME_PLUGIN, opencode_server.PROVIDER_AUTH_PLUGIN):
        (plugins / name).write_text("export default {}")
    monkeypatch.setattr(opencode_server, "PLUGINS_DIR", plugins)
    monkeypatch.setattr(opencode_server, "install_bin_scripts", lambda _log: None)
    for marker, _provider, _method in opencode_server.MANAGED_OAUTH_PROVIDERS:
        monkeypatch.delenv(marker, raising=False)
    spawn = AsyncMock(return_value=MagicMock(stdout=None, returncode=None))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    workdir = tmp_path / "repo"
    workdir.mkdir()

    async def run() -> tuple[OpenCodeServer, dict[str, str]]:
        server = make_server(tmp_path)
        monkeypatch.setattr(server, "_wait_for_health", AsyncMock())
        seed = AsyncMock()
        monkeypatch.setattr(server, "_seed_managed_credentials", seed)
        await server.start([], workdir)
        seed.assert_awaited_once()
        args, kwargs = spawn.call_args
        assert args[:2] == ("opencode", "serve")
        return server, kwargs["env"]

    return workdir, run


async def test_health_waits_until_the_session_tools_connect(tmp_path, monkeypatch):
    listings = iter(
        [
            [],
            [{"name": "oi", "status": {"status": "pending"}}],
            [{"name": "oi", "status": {"status": "connected"}}],
        ]
    )
    seen = []

    async def get(self, url, **_kwargs):
        seen.append((url, self.auth))
        return httpx.Response(200, json={"data": next(listings)})

    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    monkeypatch.setattr(opencode_server, "HEALTH_POLL_INTERVAL_SECONDS", 0)
    server = make_server(tmp_path)
    await server._wait_for_health()
    assert len(seen) == 3
    assert seen[0][0].endswith("/api/mcp")


async def test_start_passes_the_password_and_config_to_the_server(launch):
    workdir, run = launch
    server, env = await run()
    assert env[OPENCODE_PASSWORD_ENV_VAR] == server._password
    assert env["OPENCODE_DISABLE_AUTOUPDATE"] == "1"
    rules = json.loads(env["OPENCODE_CONFIG_CONTENT"])["permissions"]
    assert "execute" in {rule["action"] for rule in rules}
    plugins = workdir / ".opencode" / "plugins"
    assert sorted(path.name for path in plugins.iterdir()) == [opencode_server.RUNTIME_PLUGIN]
    # The Open Inspect tools come from the ``oi`` MCP server, not tool files.
    assert not (workdir / ".opencode" / "tool").exists()


@pytest.mark.parametrize(
    ("markers", "plugins"),
    [
        ({}, [opencode_server.RUNTIME_PLUGIN]),
        (
            {"XAI_OAUTH_MANAGED": "1"},
            [opencode_server.RUNTIME_PLUGIN, opencode_server.PROVIDER_AUTH_PLUGIN],
        ),
    ],
)
async def test_the_auth_plugin_ships_only_for_managed_subscriptions(
    launch, monkeypatch, markers, plugins
):
    workdir, run = launch
    for name, value in markers.items():
        monkeypatch.setenv(name, value)
    await run()
    installed = sorted(path.name for path in (workdir / ".opencode" / "plugins").iterdir())
    assert installed == sorted(plugins)


async def test_managed_subscriptions_get_placeholder_credentials_once(tmp_path, monkeypatch):
    for marker, _provider, _method in opencode_server.MANAGED_OAUTH_PROVIDERS:
        monkeypatch.setenv(marker, "1")
    created = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            # A restored snapshot already holds the xAI credential.
            return httpx.Response(200, json={"data": [{"integrationID": "xai"}]})
        created.append(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await make_server(tmp_path)._seed_managed_credentials(client)
    assert created == [
        {
            "integrationID": "openai",
            "label": "Open-Inspect managed subscription",
            "value": {
                "type": "oauth",
                "methodID": "chatgpt-browser",
                "refresh": opencode_server.MANAGED_REFRESH_PLACEHOLDER,
                "access": "",
                "expires": 0,
            },
        }
    ]


async def test_no_credentials_are_seeded_without_a_managed_subscription(tmp_path, monkeypatch):
    for marker, _provider, _method in opencode_server.MANAGED_OAUTH_PROVIDERS:
        monkeypatch.delenv(marker, raising=False)

    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await make_server(tmp_path)._seed_managed_credentials(client)


async def test_a_failed_credential_is_a_boot_warning_and_the_rest_are_seeded(tmp_path, monkeypatch):
    for marker, _provider, _method in opencode_server.MANAGED_OAUTH_PROVIDERS:
        monkeypatch.setenv(marker, "1")
    created = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": []})
        body = json.loads(request.content)
        if body["integrationID"] == "openai":
            return httpx.Response(500, text="boom")
        created.append(body["integrationID"])
        return httpx.Response(200, json={"data": {}})

    server = make_server(tmp_path)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await server._seed_managed_credentials(client)
    assert created == ["xai"]
    server.record_boot_warning.assert_called_once()
    assert server.record_boot_warning.call_args.kwargs["scope"] == "managed_oauth"
    assert "openai" in server.record_boot_warning.call_args.kwargs["message"]


async def test_an_unreadable_credential_list_is_a_boot_warning(tmp_path, monkeypatch):
    for marker, _provider, _method in opencode_server.MANAGED_OAUTH_PROVIDERS:
        monkeypatch.setenv(marker, "1")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(503, json={"code": "service_starting"})

    server = make_server(tmp_path)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await server._seed_managed_credentials(client)
    server.record_boot_warning.assert_called_once()
