"""Which OpenCode release an OpenCode-harness sandbox runs.

OpenCode 2 is opt-in while it is introduced: a deployment or a repository
secret sets ``OPENINSPECT_OPENCODE2=true``. The supervisor (which starts the
server) and the bridge (which talks to it) both decide from the same
environment and filesystem, so they always pick the same release.
"""

from __future__ import annotations

import secrets
import shutil
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, MutableMapping

OPENCODE2_ENV_VAR: Final = "OPENINSPECT_OPENCODE2"
OPENCODE2_BINARY: Final = "opencode2"
# Read by ``opencode serve`` and by the bridge's client. The username is fixed.
OPENCODE2_PASSWORD_ENV_VAR: Final = "OPENCODE_SERVER_PASSWORD"
OPENCODE2_USERNAME: Final = "opencode"
# OpenCode 1.x keeps a differently shaped database at ``opencode.db`` in the
# same data directory; sharing the file would corrupt whichever runs second.
OPENCODE2_DATABASE_FILE: Final = "opencode2.db"
# Control-plane-brokered subscription credentials are served to OpenCode 1.x by
# auth plugins whose hooks OpenCode 2 removed; those sessions stay on 1.x.
_MANAGED_OAUTH_ENV_VARS: Final = ("OPENAI_OAUTH_MANAGED", "XAI_OAUTH_MANAGED")


@dataclass(frozen=True)
class OpenCodeRelease:
    use_opencode2: bool
    reason: str


def select_opencode_release(
    environ: Mapping[str, str],
    which: Callable[[str], str | None] = shutil.which,
) -> OpenCodeRelease:
    if environ.get(OPENCODE2_ENV_VAR, "").strip().lower() not in {"1", "true"}:
        return OpenCodeRelease(False, "not_requested")
    if any(environ.get(name) for name in _MANAGED_OAUTH_ENV_VARS):
        return OpenCodeRelease(False, "managed_oauth_unsupported")
    if which(OPENCODE2_BINARY) is None:
        return OpenCodeRelease(False, "binary_missing")
    return OpenCodeRelease(True, "requested")


def ensure_server_password(environ: MutableMapping[str, str]) -> str:
    """The server password, generated once per boot and inherited by the bridge."""
    password = environ.get(OPENCODE2_PASSWORD_ENV_VAR)
    if not password:
        password = secrets.token_urlsafe(32)
        environ[OPENCODE2_PASSWORD_ENV_VAR] = password
    return password
