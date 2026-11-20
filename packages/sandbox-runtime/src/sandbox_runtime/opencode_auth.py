"""Credentials for the local OpenCode server's ``/api``.

``opencode serve`` requires HTTP Basic auth. The supervisor generates the
password once per boot and hands it to the server; the bridge, spawned later
from the supervisor's environment, reads the same variable.
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import MutableMapping

OPENCODE_PASSWORD_ENV_VAR: Final = "OPENCODE_SERVER_PASSWORD"
# OpenCode 2 fixes the username.
OPENCODE_USERNAME: Final = "opencode"


def ensure_server_password(environ: MutableMapping[str, str]) -> str:
    """The server password, generated once per boot and inherited by the bridge."""
    password = environ.get(OPENCODE_PASSWORD_ENV_VAR)
    if not password:
        password = secrets.token_urlsafe(32)
        environ[OPENCODE_PASSWORD_ENV_VAR] = password
    return password
