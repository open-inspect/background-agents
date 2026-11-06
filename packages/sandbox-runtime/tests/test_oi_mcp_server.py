"""The shared Open Inspect tools, served to OpenCode 2 over MCP."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest
from mcp import Client

from sandbox_runtime.harness.oi_mcp_server import _config, build_server
from sandbox_runtime.harness.tool_results import error_result, text_result
from sandbox_runtime.harness.tools import ToolDefinition


async def _echo(args):
    return text_result(f"echo {args.get('value')}")


async def _fail(_args):
    return error_result("control plane said no")


DEFINITIONS = [
    ToolDefinition(
        "spawn-child",
        "Spawn",
        {"type": "object", "properties": {"value": {"type": "string"}}},
        _echo,
    ),
    ToolDefinition("cancel-child", "Cancel", {"type": "object", "properties": {}}, _fail),
]


async def test_lists_shared_definitions_with_their_schemas():
    async with Client(build_server(DEFINITIONS)) as client:
        tools = (await client.list_tools()).tools
    assert [tool.name for tool in tools] == ["spawn-child", "cancel-child"]
    assert tools[0].input_schema["properties"] == {"value": {"type": "string"}}


async def test_calls_the_shared_handler_and_keeps_its_error_flag():
    async with Client(build_server(DEFINITIONS)) as client:
        ok = await client.call_tool("spawn-child", {"value": "x"})
        failed = await client.call_tool("cancel-child", {})
        unknown = await client.call_tool("nope", {})
    assert ok.content[0].text == "echo x"
    assert not ok.is_error
    assert failed.is_error
    assert failed.content[0].text == "control plane said no"
    assert unknown.is_error


def test_config_reads_credentials_from_the_environment():
    args = argparse.Namespace(session_id="s1", repo_manifest="/tmp/m.json", has_repository=True)
    config = _config(
        args,
        {
            "CONTROL_PLANE_URL": "https://cp",
            "SANDBOX_AUTH_TOKEN": "tok",
            "AGENT_SLACK_NOTIFY_ENABLED": "true",
        },
    )
    assert config.session_id == "s1"
    assert config.auth_token == "tok"
    assert config.repo_manifest_path == Path("/tmp/m.json")
    assert config.has_repository
    assert config.slack_notify_enabled


def test_config_requires_control_plane_credentials():
    args = argparse.Namespace(session_id="s1", repo_manifest="/tmp/m.json", has_repository=False)
    with pytest.raises(SystemExit):
        _config(args, {"CONTROL_PLANE_URL": "https://cp"})
