/**
 * How a tool is presented and run, whichever MCP server registers it.
 *
 * The hosted `/mcp` route and the local stdio server use different SDK versions, so each does its
 * own registration, but both describe a tool and turn its outcome into a result through these
 * helpers. A client then sees the same tool, and the same refusal text, from either server.
 */

import { ControlPlaneError, MISSING_PERMISSION_HINT, type ControlPlaneClient } from "./client";
import type { ToolDefinition } from "./tools";

/** The name and version both servers report to clients. */
export const MCP_SERVER_INFO = { name: "open-inspect", version: "0.1.0" } as const;

/** The description a client shows the model, naming the grant the tool needs. */
export function toolDescription(tool: ToolDefinition): string {
  return `${tool.description} Requires a token granted ${tool.requires}.`;
}

/** The MCP annotations a client uses to decide how hard to prompt before a call. */
export function toolAnnotations(tool: ToolDefinition): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: tool.readOnly,
    // A client uses this to decide how hard to prompt, so a write that replaces what later
    // readers act on has to declare itself even when it is recoverable.
    destructiveHint: tool.destructive ?? false,
    openWorldHint: true,
  };
}

/** An MCP tool result. Indexable, as the SDKs' result types are, so either SDK accepts it. */
export type ToolCallOutcome = {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Run a tool and shape its outcome as an MCP tool result. A refusal is information the model can
 * act on, so it is tool output with `isError`, not a protocol error.
 */
export async function callTool(
  tool: ToolDefinition,
  client: ControlPlaneClient,
  args: unknown
): Promise<ToolCallOutcome> {
  try {
    const result = await tool.run(client, args);
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return { content: [{ type: "text", text: refusalText(tool, error) }], isError: true };
  }
}

/**
 * What a failed call tells the model. A resource route refuses a missing permission without
 * naming it, so the tool names the grant it needs in place of the generic hint.
 */
function refusalText(tool: ToolDefinition, error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error instanceof ControlPlaneError && error.reasonCode === "missing_permission") {
    return error.message.replace(
      MISSING_PERMISSION_HINT,
      `This tool needs a token granted ${tool.requires}, and this token lacks one of them, or ` +
        "its owner no longer holds it. Issue a token that includes them under Settings > Access tokens."
    );
  }
  return error.message;
}
