/**
 * The tool surface as a client sees it, checked over a real MCP transport.
 *
 * Both servers that register the tools (the hosted `/mcp` route and the local stdio server) run
 * this suite against their own registration, so the tool list, write hints, schemas, argument
 * validation, and descriptions cannot drift between them.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneError, MISSING_PERMISSION_HINT, type ControlPlaneClient } from "./client";
import { TOOLS } from "./tools";

/** A control-plane client whose requests are recorded and answered by the handlers given. */
export function fakeToolClient(handlers: {
  get?: (path: string, query?: unknown) => unknown;
  post?: (path: string, body?: unknown, options?: unknown) => unknown;
  patch?: (path: string, body?: unknown) => unknown;
}) {
  const get = vi.fn(async (path: string, query?: unknown) => handlers.get?.(path, query));
  const post = vi.fn(async (path: string, body?: unknown, options?: unknown) =>
    handlers.post?.(path, body, options)
  );
  const patch = vi.fn(async (path: string, body?: unknown) => handlers.patch?.(path, body));
  const client = { get, post, patch, withSignal: () => client } as unknown as ControlPlaneClient;
  return { client, get, post, patch };
}

/** Connects an MCP client to a server whose tools act through `client`. */
export type ConnectToolServer = (client: ControlPlaneClient) => Promise<Client>;

/** Register the tool-surface suite for one server's registration. */
export function describeToolSurface(server: string, connect: ConnectToolServer): void {
  describe(`tool surface (${server})`, () => {
    it("lists every tool over a real transport, schemas converted and hints set", async () => {
      // tools/list is where a zod shape the SDK cannot convert to JSON Schema
      // actually fails, and where a client reads the write hints. Exercising the
      // real path catches both; constructing the server alone catches neither.
      const mcpClient = await connect(fakeToolClient({}).client);

      const { tools } = await mcpClient.listTools();
      expect(tools.map((entry) => entry.name).sort()).toEqual(
        TOOLS.map((entry) => entry.name).sort()
      );

      const writes = tools.filter((entry) => entry.annotations?.readOnlyHint === false);
      expect(writes.map((entry) => entry.name).sort()).toEqual([
        "archive_session",
        "create_automation",
        "create_session",
        "import_skill_from_git",
        "rename_session",
        "send_prompt",
        "stop_session",
        "trigger_automation",
        "unarchive_session",
        "update_skill_from_git",
      ]);
      expect(tools).toHaveLength(22);
      // Re-import moves the skill's current revision, which is what later
      // sessions load; a client reads this to decide how hard to prompt.
      const hints = Object.fromEntries(
        tools.map((entry) => [entry.name, entry.annotations?.destructiveHint])
      );
      expect(hints.update_skill_from_git).toBe(true);
      expect(hints.import_skill_from_git).toBe(false);
      expect(hints.list_skills).toBe(false);
      // Starting or steering a session adds work; it replaces nothing a later reader acts on.
      expect(hints.create_session).toBe(false);
      expect(hints.send_prompt).toBe(false);
      // Each lifecycle write changes the session in place, so a client is told to prompt harder,
      // even for the ones that can be undone.
      for (const name of [
        "stop_session",
        "archive_session",
        "unarchive_session",
        "rename_session",
      ]) {
        expect(hints[name], name).toBe(true);
      }
      expect(hints.list_session_children).toBe(false);
      expect(hints.get_session_child).toBe(false);

      // The nested unions are the shapes most likely to fail: the import tool's
      // assignments, and the shared trigger-condition union that create_automation
      // reuses rather than restating.
      const importTool = tools.find((entry) => entry.name === "import_skill_from_git");
      expect(importTool?.inputSchema.properties).toHaveProperty("assignments");
      const createTool = tools.find((entry) => entry.name === "create_automation");
      expect(createTool?.inputSchema.properties).toHaveProperty("trigger_config");
      expect(createTool?.inputSchema.required).toEqual(["name", "instructions"]);
      const renameTool = tools.find((entry) => entry.name === "rename_session");
      expect(renameTool?.inputSchema.required).toEqual(["session_id", "title"]);
      const childTool = tools.find((entry) => entry.name === "get_session_child");
      expect(childTool?.inputSchema.required).toEqual(["session_id", "child_id"]);
      await mcpClient.close();
    });

    it("validates and forwards a call over a real transport, and refuses invalid arguments", async () => {
      // The SDK validates arguments with these schemas, which may be built on a different zod
      // than the SDK resolves; this is the runtime half of the type bridge at registration.
      const { client, get } = fakeToolClient({ get: () => ({ sessions: [] }) });
      const mcpClient = await connect(client);

      const ok = await mcpClient.callTool({
        name: "list_sessions",
        arguments: { status: "active", limit: 5 },
      });
      expect(ok.isError).toBeFalsy();
      expect(get).toHaveBeenCalledWith("/sessions", {
        status: "active",
        limit: 5,
        offset: undefined,
      });

      const invalid = await mcpClient.callTool({
        name: "list_sessions",
        arguments: { status: "running" },
      });
      expect(invalid.isError).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
      await mcpClient.close();
    });

    it("forwards a session rename over a real transport, and refuses a blank title", async () => {
      const { client, patch } = fakeToolClient({ patch: () => ({ title: "Fix the flaky test" }) });
      const mcpClient = await connect(client);

      const renamed = await mcpClient.callTool({
        name: "rename_session",
        arguments: { session_id: "s1", title: "  Fix the flaky test " },
      });
      expect(renamed.isError).toBeFalsy();
      expect(patch).toHaveBeenCalledWith("/sessions/s1/title", { title: "Fix the flaky test" });

      const blank = await mcpClient.callTool({
        name: "rename_session",
        arguments: { session_id: "s1", title: "   " },
      });
      expect(blank.isError).toBe(true);
      expect(patch).toHaveBeenCalledTimes(1);
      await mcpClient.close();
    });

    it("names the tool's own grant when a route refuses a permission it does not name", async () => {
      // Under enforced teams a session route refuses with `missing_permission` alone.
      const refusal = new ControlPlaneError(
        `POST /sessions/s1/archive returned 403: {"reason_code":"missing_permission"}\n` +
          MISSING_PERMISSION_HINT,
        403,
        "missing_permission"
      );
      const { client } = fakeToolClient({
        post: () => {
          throw refusal;
        },
      });
      const mcpClient = await connect(client);

      const refused = await mcpClient.callTool({
        name: "archive_session",
        arguments: { session_id: "s1" },
      });
      expect(refused.isError).toBe(true);
      const [text] = refused.content as { type: string; text: string }[];
      expect(text?.text).toContain("returned 403");
      expect(text?.text).toContain(
        "This tool needs a token granted sessions.read and sessions.lifecycle"
      );
      expect(text?.text).not.toContain(MISSING_PERMISSION_HINT);
      await mcpClient.close();
    });

    it("states the grant every tool needs in the description the model reads", async () => {
      const mcpClient = await connect(fakeToolClient({}).client);

      const { tools } = await mcpClient.listTools();
      for (const definition of TOOLS) {
        const listed = tools.find((entry) => entry.name === definition.name);
        expect(listed?.description).toContain(`Requires a token granted ${definition.requires}.`);
      }
      await mcpClient.close();
    });
  });
}
