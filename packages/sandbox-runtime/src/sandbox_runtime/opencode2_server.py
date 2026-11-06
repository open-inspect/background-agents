"""Supervisor half of the OpenCode 2 harness: stage the workspace and run ``opencode2 serve``."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import httpx

from .constants import OPENCODE_PORT, REPO_MANIFEST_FILE_PATH
from .git_excludes import install_runtime_git_excludes
from .memories import memory_path
from .opencode2_runtime import (
    OPENCODE2_BINARY,
    OPENCODE2_DATABASE_FILE,
    OPENCODE2_PASSWORD_ENV_VAR,
    OPENCODE2_USERNAME,
    ensure_server_password,
)
from .opencode_server import (
    _LOG_FORWARD_STREAM_LIMIT_BYTES,
    OpenCodeServer,
    resolve_opencode_global_config_dir,
)
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

    from .repo_config import RepoEntry
    from .runtime_config import OpenCodeConfig

RUNTIME_PLUGIN: Final = Path("/app/sandbox_runtime/plugins/opencode2-runtime.js")

# Ordered, last match wins. Everything is allowed: the sandbox is the boundary
# and no one is there to answer a permission prompt. Then:
# - ``execute`` is Code Mode. Denying it exposes every tool, MCP tools
#   included, as a direct tool, the way 1.x presents them.
# - ``question`` waits for a human answer the bridge cannot relay.
# - Worktrees and moving the session would take the agent out of the
#   workspace the session is bound to.
PERMISSIONS: Final = (
    {"action": "*", "resource": "*", "effect": "allow"},
    {"action": "execute", "resource": "*", "effect": "deny"},
    {"action": "question", "resource": "*", "effect": "deny"},
    {"action": "opencode_worktree_*", "resource": "*", "effect": "deny"},
    {"action": "opencode_session_move", "resource": "*", "effect": "deny"},
)


class OpenCode2Server(OpenCodeServer):
    """``opencode2 serve`` with the same workspace, skills and MCP servers as 1.x.

    What differs from 1.x: the API requires a per-boot password, shared with
    the bridge through the environment; the database lives in its own file;
    and the Open Inspect tools come from the ``oi`` MCP server rather than
    ``.opencode/tool`` files, which OpenCode 2 no longer loads.
    """

    def __init__(
        self,
        config: OpenCodeConfig,
        shutdown_event: asyncio.Event,
        log: Any,
        record_boot_warning: Callable[..., None],
        environ: dict[str, str] | os._Environ[str] | None = None,
    ) -> None:
        super().__init__(config, shutdown_event, log, record_boot_warning)
        self.session_id = config.session_id
        # The bridge is spawned later from this process's environment.
        self._password = ensure_server_password(os.environ if environ is None else environ)

    def build_config(self, mcp_config: Mapping[str, Any]) -> dict[str, Any]:
        config: dict[str, Any] = {
            "model": f"{self.provider}/{self.model}",
            "permissions": [dict(rule) for rule in PERMISSIONS],
            "mcp": {**mcp_config, "oi": self._oi_mcp_server()},
        }
        memory_file = memory_path(resolve_opencode_global_config_dir())
        if memory_file.is_file() and memory_file.stat().st_size:
            config["instructions"] = [str(memory_file)]
        return config

    def _oi_mcp_server(self) -> dict[str, Any]:
        command = [
            sys.executable,
            "-m",
            "sandbox_runtime.harness.oi_mcp_server",
            "--session-id",
            self.session_id,
            "--repo-manifest",
            REPO_MANIFEST_FILE_PATH,
        ]
        if self.has_repository:
            command.append("--has-repository")
        return {"type": "local", "command": command}

    def _install_runtime_plugin(self, workdir: Path) -> set[str]:
        if not RUNTIME_PLUGIN.is_file():
            return set()
        plugin_dir = workdir / ".opencode" / "plugins"
        plugin_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(RUNTIME_PLUGIN, plugin_dir / RUNTIME_PLUGIN.name)
        return {f".opencode/plugins/{RUNTIME_PLUGIN.name}"}

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        self.log.info("opencode.start", release=2)
        mcp_servers = self._resolve_mcp_servers()
        mcp_config: dict[str, Any] = {}
        if mcp_servers:
            await self._install_mcp_packages(mcp_servers)
            mcp_config = self._build_mcp_config(mcp_servers)
            self.log.info("mcp.configured", count=len(mcp_config))

        self._assemble_workspace_opencode(repositories)
        installed = self._install_skills(workdir)
        installed.update(self._install_runtime_plugin(workdir))
        install_bin_scripts(self.log)
        if installed and (workdir / ".git").exists():
            try:
                install_runtime_git_excludes(workdir, installed)
            except Exception as error:
                self.log.warn("opencode.git_excludes_failed", exc=error)

        env = {
            **os.environ,
            OPENCODE2_PASSWORD_ENV_VAR: self._password,
            "OPENCODE_CONFIG_CONTENT": json.dumps(self.build_config(mcp_config)),
            "OPENCODE_DB": OPENCODE2_DATABASE_FILE,
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
        }
        self._opencode_process = await asyncio.create_subprocess_exec(
            OPENCODE2_BINARY,
            "serve",
            "--port",
            str(OPENCODE_PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",
            cwd=workdir,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_opencode_logs())
        await self._wait_for_health()
        self.log.info("opencode.ready", release=2)

    async def _wait_for_health(self) -> None:
        """Poll the authenticated ``/api/info`` until the server answers."""
        info_url = f"http://localhost:{OPENCODE_PORT}/api/info"
        auth = httpx.BasicAuth(OPENCODE2_USERNAME, self._password)
        start_time = time.time()
        async with httpx.AsyncClient(auth=auth) as client:
            while time.time() - start_time < self.HEALTH_CHECK_TIMEOUT:
                if self.shutdown_event.is_set():
                    raise RuntimeError("Shutdown requested during startup")
                if self._opencode_process and self._opencode_process.returncode is not None:
                    raise RuntimeError(
                        f"OpenCode server exited with status {self._opencode_process.returncode}"
                    )
                try:
                    response = await client.get(info_url, timeout=2.0)
                    if response.status_code == 200:
                        return
                except httpx.ConnectError:
                    pass
                except Exception as error:
                    self.log.debug("opencode.health_check_error", exc=error)
                await asyncio.sleep(0.5)
        raise RuntimeError("OpenCode server failed to become healthy")
