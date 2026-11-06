"""Serve the shared Open Inspect tools to OpenCode 2 as a stdio MCP server.

OpenCode 2 no longer loads ``.opencode/tool/*.js``, so instead of porting the
JavaScript tools a second time it gets the same definitions the Claude and
Codex harnesses use (``tools.py``). OpenCode spawns this module as the local
MCP server ``oi``; it inherits OpenCode's environment, which already carries
the control-plane URL and sandbox token the 1.x JavaScript tools read.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from ..constants import REPO_MANIFEST_FILE_PATH
from ..log_config import JSONFormatter, get_logger
from .tools import OI_TOOL_SERVER_NAME, ControlPlaneToolClient, ToolServerConfig, build_tools

if TYPE_CHECKING:
    from .tools import ToolDefinition


def _config(args: argparse.Namespace, environ: dict[str, str]) -> ToolServerConfig:
    control_plane_url = environ.get("CONTROL_PLANE_URL", "")
    auth_token = environ.get("SANDBOX_AUTH_TOKEN", "")
    if not control_plane_url or not auth_token:
        raise SystemExit("CONTROL_PLANE_URL and SANDBOX_AUTH_TOKEN are required")
    return ToolServerConfig(
        control_plane_url=control_plane_url,
        session_id=args.session_id,
        auth_token=auth_token,
        repo_manifest_path=Path(args.repo_manifest),
        has_repository=args.has_repository,
        slack_notify_enabled=environ.get("AGENT_SLACK_NOTIFY_ENABLED", "").lower() == "true",
    )


def build_server(definitions: list[ToolDefinition]) -> Server[Any]:
    by_name = {definition.name: definition for definition in definitions}

    async def list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=definition.name,
                    description=definition.description,
                    input_schema=definition.input_schema,
                )
                for definition in definitions
            ]
        )

    async def call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        definition = by_name.get(params.name)
        if definition is None:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"Unknown tool: {params.name}")],
                is_error=True,
            )
        result = await definition.handler(params.arguments or {})
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=result.text)],
            is_error=result.is_error,
        )

    return Server(
        OI_TOOL_SERVER_NAME, version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool
    )


async def _serve(config: ToolServerConfig) -> None:
    client = ControlPlaneToolClient(config, get_logger("oi_mcp_server"))
    server = build_server(build_tools(client))
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="oi_mcp_server")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--repo-manifest", default=REPO_MANIFEST_FILE_PATH)
    parser.add_argument("--has-repository", action="store_true")
    args = parser.parse_args(argv)
    # stdout is the MCP channel: every log line goes to stderr.
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JSONFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    asyncio.run(_serve(_config(args, dict(os.environ))))


if __name__ == "__main__":
    main()
