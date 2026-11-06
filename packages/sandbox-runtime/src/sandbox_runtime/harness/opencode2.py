"""``AgentHarness`` over the bundled local OpenCode 2 server."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .opencode import OpencodeHarness
from .opencode2_stream import OpenCode2PromptStream

if TYPE_CHECKING:
    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger
    from .base import PromptLimits
    from .opencode2_client import OpenCode2Client


class Opencode2Harness(OpencodeHarness):
    """OpenCode 2 behind the same seam as 1.x: still the ``opencode`` harness.

    Session lifecycle, managed MCP toggling, abort and stop share 1.x's
    control flow; the client speaks OpenCode 2's API and the prompt stream
    translates its events.
    """

    def __init__(
        self,
        *,
        client: OpenCode2Client,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        limits: PromptLimits,
        managed_mcp_names: tuple[str, ...] = (),
    ) -> None:
        super().__init__(
            client=client,
            attachment_processor=attachment_processor,
            log=log,
            limits=limits,
            managed_mcp_names=managed_mcp_names,
        )
        self.client: OpenCode2Client = client
        self._prompt_stream_v2: OpenCode2PromptStream | None = None

    @property
    def prompt_stream(self) -> Any:
        if self._prompt_stream_v2 is None:
            self._prompt_stream_v2 = OpenCode2PromptStream(
                client=self.client,
                attachment_processor=self.attachment_processor,
                log=self.log,
                sse_inactivity_timeout_seconds=self.limits.inactivity_timeout_seconds,
                prompt_max_duration_seconds=self.limits.prompt_max_duration_seconds,
                prompt_cleanup_timeout_seconds=self.limits.prompt_cleanup_timeout_seconds,
            )
        return self._prompt_stream_v2
