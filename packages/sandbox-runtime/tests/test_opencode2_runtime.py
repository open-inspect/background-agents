"""Choosing between OpenCode 1.x and OpenCode 2, and the server that runs 2."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime import opencode2_server
from sandbox_runtime.opencode2_runtime import (
    OPENCODE2_PASSWORD_ENV_VAR,
    ensure_server_password,
    select_opencode_release,
)
from sandbox_runtime.opencode2_server import OpenCode2Server
from sandbox_runtime.runtime_config import OpenCodeConfig

if TYPE_CHECKING:
    from pathlib import Path


def installed(_name: str) -> str:
    return "/opt/openinspect/bin/opencode2"


@pytest.mark.parametrize(
    ("environ", "which", "expected"),
    [
        ({}, installed, (False, "not_requested")),
        ({"OPENINSPECT_OPENCODE2": "false"}, installed, (False, "not_requested")),
        ({"OPENINSPECT_OPENCODE2": "true"}, installed, (True, "requested")),
        ({"OPENINSPECT_OPENCODE2": "1"}, installed, (True, "requested")),
        ({"OPENINSPECT_OPENCODE2": "true"}, lambda _n: None, (False, "binary_missing")),
        (
            {"OPENINSPECT_OPENCODE2": "true", "OPENAI_OAUTH_MANAGED": "1"},
            installed,
            (False, "managed_oauth_unsupported"),
        ),
        (
            {"OPENINSPECT_OPENCODE2": "true", "XAI_OAUTH_MANAGED": "true"},
            installed,
            (False, "managed_oauth_unsupported"),
        ),
    ],
)
def test_release_selection(environ, which, expected):
    release = select_opencode_release(environ, which)
    assert (release.use_opencode2, release.reason) == expected


def test_password_is_generated_once_and_shared_through_the_environment():
    environ: dict[str, str] = {}
    first = ensure_server_password(environ)
    assert len(first) >= 32
    assert environ[OPENCODE2_PASSWORD_ENV_VAR] == first
    assert ensure_server_password(environ) == first


def make_server(tmp_path: Path, *, mcp_servers=(), has_repository=True) -> OpenCode2Server:
    config = OpenCodeConfig(
        provider="anthropic",
        model="claude-opus-5-5",
        mcp_servers=tuple(mcp_servers),
        has_repository=has_repository,
        workspace_path=tmp_path,
        session_id="sess-1",
    )
    return OpenCode2Server(config, asyncio.Event(), MagicMock(), MagicMock(), environ={})


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


async def test_start_runs_opencode2_with_its_own_database_and_password(tmp_path, monkeypatch):
    plugin = tmp_path / "opencode2-runtime.js"
    plugin.write_text("export default {}")
    monkeypatch.setattr(opencode2_server, "RUNTIME_PLUGIN", plugin)
    monkeypatch.setattr(opencode2_server, "install_bin_scripts", lambda _log: None)
    process = MagicMock(stdout=None, returncode=None)
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    workdir = tmp_path / "repo"
    workdir.mkdir()
    server = make_server(tmp_path)
    monkeypatch.setattr(server, "_wait_for_health", AsyncMock())

    await server.start([], workdir)

    args, kwargs = spawn.call_args
    assert args[:2] == ("opencode2", "serve")
    env = kwargs["env"]
    assert env["OPENCODE_DB"] == "opencode2.db"
    assert env[OPENCODE2_PASSWORD_ENV_VAR] == server._password
    assert "execute" in {
        rule["action"] for rule in json.loads(env["OPENCODE_CONFIG_CONTENT"])["permissions"]
    }
    assert (workdir / ".opencode" / "plugins" / "opencode2-runtime.js").is_file()
    # 1.x's JavaScript tools are not staged: OpenCode 2 would ignore them.
    assert not (workdir / ".opencode" / "tool").exists()
