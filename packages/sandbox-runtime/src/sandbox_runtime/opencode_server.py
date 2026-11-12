from __future__ import annotations

import asyncio
import contextlib
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
from .harness.tools import OI_TOOL_SERVER_NAME as OI_MCP_SERVER_NAME
from .managed_mcp import managed_marker
from .mcp_packages import McpPackageInstaller
from .memories import memory_path
from .opencode_auth import OPENCODE_PASSWORD_ENV_VAR, OPENCODE_USERNAME, ensure_server_password
from .process_output import iter_process_lines
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

    from .repo_config import RepoEntry
    from .runtime_config import OpenCodeConfig

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
PLUGINS_DIR: Final = Path("/app/sandbox_runtime/plugins")
RUNTIME_PLUGIN: Final = "opencode-runtime.js"
PROVIDER_AUTH_PLUGIN: Final = "provider-auth.js"
# Subscriptions whose rotating refresh tokens stay in the control plane:
# (environment marker, OpenCode integration, OpenCode sign-in method).
MANAGED_OAUTH_PROVIDERS: Final = (
    ("OPENAI_OAUTH_MANAGED", "openai", "chatgpt-browser"),
    ("XAI_OAUTH_MANAGED", "xai", "device"),
)
MANAGED_REFRESH_PLACEHOLDER: Final = "managed-by-control-plane"
HEALTH_POLL_INTERVAL_SECONDS: Final = 0.25

# Ordered, last match wins. Everything is allowed: the sandbox is the boundary
# and no one is there to answer a permission prompt. Then:
# - ``execute`` is Code Mode. Denying it exposes every tool, MCP tools
#   included, to the model directly.
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


def resolve_opencode_global_config_dir() -> Path:
    """Resolve OpenCode's global config directory using its xdg-basedir rules."""
    override = os.environ.get("OPENCODE_CONFIG_DIR")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "opencode"


class OpenCodeServer:
    """Stage the workspace and run ``opencode serve`` for the bridge to drive.

    The API requires a per-boot password, shared with the bridge through the
    environment. The Open Inspect tools come from the ``oi`` MCP server.
    """

    HEALTH_CHECK_TIMEOUT = 30.0

    def __init__(
        self,
        config: OpenCodeConfig,
        shutdown_event: asyncio.Event,
        log: Any,
        record_boot_warning: Callable[..., None],
        environ: dict[str, str] | os._Environ[str] | None = None,
    ) -> None:
        self.shutdown_event = shutdown_event
        self.log = log
        self.record_boot_warning = record_boot_warning
        self.has_repository = config.has_repository
        self.workspace_path = config.workspace_path
        self.provider = config.provider
        self.model = config.model
        self.mcp_servers = config.mcp_servers
        self._mcp_packages = McpPackageInstaller(log)
        self.session_id = config.session_id
        self._opencode_process: asyncio.subprocess.Process | None = None
        # The bridge is spawned later from this process's environment.
        self._password = ensure_server_password(os.environ if environ is None else environ)

    def _assemble_workspace_opencode(self, repositories: Sequence[RepoEntry]) -> None:
        """Merge member repos' .opencode/ into the workspace root (multi-repo only).

        OpenCode discovers config relative to its cwd — /workspace for
        multi-repo sessions — so per-repo custom tools/skills/commands would
        never load. Files are copied in position order, last write wins with a
        warning naming both members; the runtime's skills and plugins installed
        afterwards still override on filename collision.
        """
        if len(repositories) <= 1:
            return

        dest_root = self.workspace_path / ".opencode"
        # The merged tree is generated state: rebuild it from scratch so
        # entries removed from a member (or a removed member) don't survive
        # snapshot/repo-image boots. The runtime's skills and plugins are
        # re-installed after assembly on every boot.
        if dest_root.is_dir():
            for child in dest_root.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
        provenance: dict[str, RepoEntry] = {}
        for repo in repositories:
            src_root = repo.path / ".opencode"
            if not src_root.is_dir():
                continue
            for src in sorted(src_root.rglob("*")):
                if not src.is_file():
                    continue
                rel = src.relative_to(src_root)
                if any(part in ("node_modules", "__pycache__") for part in rel.parts):
                    continue
                prior = provenance.get(str(rel))
                if prior is not None:
                    self.record_boot_warning(
                        scope="assembly",
                        repo=repo,
                        message=(
                            f".opencode/{rel} from {prior.owner}/{prior.name} is overridden "
                            f"by {repo.owner}/{repo.name} (later repositories win)"
                        ),
                    )
                dest = dest_root / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                provenance[str(rel)] = repo

        if provenance:
            self.log.info(
                "opencode.workspace_assembled",
                file_count=len(provenance),
                repo_count=len(repositories),
            )

    def _install_skills(self, workdir: Path) -> set[str]:
        """Copy bundled Skills into the .opencode/skills directory."""
        installed: set[str] = set()
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return installed

        skills_dest = workdir / ".opencode" / "skills"
        installed_any = False

        for skill_dir in skills_dir.iterdir():
            skill_file = skill_dir / "SKILL.md"
            if not skill_dir.is_dir() or not skill_file.exists():
                continue

            dest_dir = skills_dest / skill_dir.name
            # Preserve symlinks rather than dereferencing paths outside the bundled skill.
            shutil.copytree(
                skill_dir,
                dest_dir,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                symlinks=True,
            )
            for source in skill_dir.rglob("*"):
                relative = source.relative_to(skill_dir)
                if any(part == "__pycache__" for part in relative.parts):
                    continue
                if source.name == ".DS_Store" or source.suffix == ".pyc":
                    continue
                if source.is_file() or source.is_symlink():
                    installed.add((Path(".opencode/skills") / skill_dir.name / relative).as_posix())
            installed_any = True

        if installed_any:
            self.log.info("opencode.skills_installed", skills_path=str(skills_dest))
        return installed

    @staticmethod
    def _managed_oauth_providers() -> list[tuple[str, str]]:
        """``(integration, sign-in method)`` for each control-plane-managed subscription."""
        return [
            (provider, method)
            for marker, provider, method in MANAGED_OAUTH_PROVIDERS
            if os.environ.get(marker)
        ]

    async def _seed_managed_credentials(self, client: httpx.AsyncClient) -> None:
        """Give each managed subscription an expired placeholder credential.

        OpenCode treats the credential like a signed-in subscription and
        refreshes it before use; ``provider-auth.js`` replaces that refresh
        with the control plane's token broker. A restored snapshot already has
        the credential in OpenCode's database, so existing ones are kept.
        """
        providers = self._managed_oauth_providers()
        if not providers:
            return
        api = f"http://localhost:{OPENCODE_PORT}/api"
        # A failure only costs that subscription's models, so the session still boots.
        try:
            listing = await client.get(f"{api}/credential")
            listing.raise_for_status()
            existing = {entry.get("integrationID") for entry in listing.json().get("data", [])}
        except httpx.HTTPError as error:
            self.record_boot_warning(
                scope="managed_oauth",
                message=f"Could not list OpenCode credentials; subscriptions are unavailable: {error}",
            )
            return
        seeded = []
        for provider, method in providers:
            if provider not in existing:
                try:
                    response = await client.post(
                        f"{api}/credential",
                        json={
                            "integrationID": provider,
                            "label": "Open-Inspect managed subscription",
                            "value": {
                                "type": "oauth",
                                "methodID": method,
                                "refresh": MANAGED_REFRESH_PLACEHOLDER,
                                "access": "",
                                "expires": 0,
                            },
                        },
                    )
                    response.raise_for_status()
                except httpx.HTTPError as error:
                    self.record_boot_warning(
                        scope="managed_oauth",
                        message=f"Could not set up the {provider} subscription: {error}",
                    )
                    continue
            seeded.append(provider)
        self.log.info("managed_oauth.setup", providers=seeded)

    def _resolve_mcp_servers(self) -> list[Mapping[str, Any]]:
        """Resolve MCP servers from session config."""
        return list(self.mcp_servers)

    async def _install_mcp_packages(self, servers: list[Mapping[str, Any]]) -> None:
        await self._mcp_packages.install(servers)

    def _build_mcp_config(self, servers: list[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
        """Convert MCP server list to OpenCode mcp config format."""
        config: dict[str, dict[str, Any]] = {}
        for server in servers:
            name = server.get("name", "")
            if not name:
                continue
            if server.get("type") == "remote":
                entry: dict[str, Any] = {"type": "remote", "url": server.get("url", "")}
                marker = managed_marker(server)
                auth_headers = (
                    (server.get("headers") or {})
                    if marker
                    else (server.get("headers") or server.get("env") or {})
                )
                if marker:
                    entry["oauth"] = False
                    if marker["auth_mode"] == "user_oauth":
                        entry["enabled"] = False
                if auth_headers:
                    entry["headers"] = dict(auth_headers)
                config[name] = entry
            else:
                entry = {
                    "type": "local",
                    "command": server.get("command", []),
                }
                if server.get("env"):
                    entry["environment"] = dict(server["env"])
                config[name] = entry
        return config

    def build_config(self, mcp_config: Mapping[str, Any]) -> dict[str, Any]:
        config: dict[str, Any] = {
            "model": f"{self.provider}/{self.model}",
            "permissions": [dict(rule) for rule in PERMISSIONS],
            "mcp": {**mcp_config, OI_MCP_SERVER_NAME: self._oi_mcp_server()},
            # The catalog gives these models no reasoning variants; the
            # bridge selects ``high`` and ``max`` as variants by name.
            "provider": {
                "anthropic": {
                    "models": {
                        model: {
                            "variants": {
                                effort: {"thinking": {"type": "enabled", "budgetTokens": budget}}
                                for effort, budget in (("high", 16_000), ("max", 31_999))
                            }
                        }
                        for model in ("claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5")
                    }
                }
            },
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

    def _install_plugins(self, workdir: Path) -> set[str]:
        """Copy the runtime's plugins into ``.opencode/plugins``, where OpenCode loads them."""
        names = [RUNTIME_PLUGIN]
        if self._managed_oauth_providers():
            names.append(PROVIDER_AUTH_PLUGIN)
        installed: set[str] = set()
        plugin_dir = workdir / ".opencode" / "plugins"
        for name in names:
            source = PLUGINS_DIR / name
            if not source.is_file():
                continue
            plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(source, plugin_dir / name)
            installed.add(f".opencode/plugins/{name}")
        return installed

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        """Start the OpenCode server with the session's configuration."""
        self.log.info("opencode.start")
        mcp_servers = self._resolve_mcp_servers()
        mcp_config: dict[str, Any] = {}
        if mcp_servers:
            await self._install_mcp_packages(mcp_servers)
            mcp_config = self._build_mcp_config(mcp_servers)
            self.log.info("mcp.configured", count=len(mcp_config))

        # Working directory: the repo for single-repo sessions, /workspace
        # for multi-repo (every member visible) and repo-less sessions.
        self._assemble_workspace_opencode(repositories)
        installed = self._install_skills(workdir)
        installed.update(self._install_plugins(workdir))
        install_bin_scripts(self.log)
        if installed and (workdir / ".git").exists():
            try:
                install_runtime_git_excludes(workdir, installed)
            except Exception as error:
                self.log.warn("opencode.git_excludes_failed", exc=error)

        env = {
            **os.environ,
            OPENCODE_PASSWORD_ENV_VAR: self._password,
            "OPENCODE_CONFIG_CONTENT": json.dumps(self.build_config(mcp_config)),
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
        }
        self._opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
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
        async with httpx.AsyncClient(
            auth=httpx.BasicAuth(OPENCODE_USERNAME, self._password), timeout=10.0
        ) as client:
            await self._seed_managed_credentials(client)
        self.log.info("opencode.ready")

    async def _forward_opencode_logs(self) -> None:
        """Forward OpenCode stdout to supervisor stdout."""
        if not self._opencode_process or not self._opencode_process.stdout:
            return
        async for line in iter_process_lines(
            self._opencode_process.stdout,
            on_error=lambda error: self.log.warn("opencode.log_forward_error", exc=error),
        ):
            print(f"[opencode] {line}")

    async def _wait_for_health(self) -> None:
        """Poll until the server answers and the session tools are ready.

        OpenCode loads a workspace on the first request that touches it and
        answers that request from the empty state; MCP connect and disconnect
        calls in that window fail as unknown servers. It then starts the MCP
        servers in the background, and a prompt sent before ``oi`` connects
        runs without the session tools. So the server is ready once ``oi`` has
        left ``pending``.
        """
        mcp_url = f"http://localhost:{OPENCODE_PORT}/api/mcp"
        auth = httpx.BasicAuth(OPENCODE_USERNAME, self._password)
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
                    response = await client.get(mcp_url, timeout=2.0)
                    oi_status = next(
                        (
                            (server.get("status") or {}).get("status")
                            for server in response.json().get("data", [])
                            if server.get("name") == OI_MCP_SERVER_NAME
                        ),
                        None,
                    )
                    if response.status_code == 200 and oi_status not in {None, "pending"}:
                        if oi_status != "connected":
                            self.log.warn("opencode.oi_mcp_unavailable", status=oi_status)
                        return
                except httpx.ConnectError:
                    pass
                except Exception as error:
                    self.log.debug("opencode.health_check_error", exc=error)
                await asyncio.sleep(HEALTH_POLL_INTERVAL_SECONDS)
        raise RuntimeError("OpenCode server failed to become healthy")

    async def stop(self) -> None:
        if self._opencode_process and self._opencode_process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._opencode_process.terminate()
            try:
                await asyncio.wait_for(self._opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self._opencode_process.kill()
                try:
                    await asyncio.wait_for(self._opencode_process.wait(), timeout=10.0)
                except TimeoutError:
                    self.log.warn("opencode.stop_timeout")

    def exit_code(self) -> int | None:
        """Return OpenCode's exit code, or None while absent/running."""
        return self._opencode_process.returncode if self._opencode_process else None

    def started(self) -> bool:
        """Return whether an OpenCode process has been created."""
        return self._opencode_process is not None
