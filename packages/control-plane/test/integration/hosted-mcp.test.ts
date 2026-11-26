/**
 * The hosted MCP server at `/mcp`, through the deployed Worker against real D1 and the session
 * Durable Object, with a real MCP client: the API policy's switch, the bearer and origin checks,
 * and tool calls admitted, narrowed, and audited by the routes they reach, as direct calls are.
 */

import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { SessionIndexStore } from "../../src/db/session-index";
import { HOSTED_MCP_MAX_REQUEST_BODY_BYTES } from "../../src/routes/hosted-mcp";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
  routeRequest,
  seedActiveUser,
  serviceFetch,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

const BASE = "https://cp.test";
const OWNER = "77777777777777777777777777777777";
const OTHER = "88888888888888888888888888888888";

async function issueToken(userId: string, permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId,
    name: "mcp",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

/** A real MCP client connected to the Worker's `/mcp` with the given token. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    // Without the client's abort signal: closing the client aborts it, and workerd reports the
    // abort of an already-answered exchange as an unhandled rejection.
    fetch: (url, init) => SELF.fetch(url, { ...init, signal: undefined }),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "integration", version: "0" });
  await client.connect(transport);
  return client;
}

/** `connect`, against a Worker running with the given teams enforcement mode. */
async function connectIn(mode: "off" | "on", token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) =>
      routeRequest(
        new Request(url, { ...init, signal: undefined }),
        { ...env, TEAMS_ENFORCEMENT: mode },
        createExecutionContext()
      ),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "integration", version: "0" });
  await client.connect(transport);
  return client;
}

/** The first text block of a tool result. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

/** One raw MCP POST, for the checks that run before any MCP exchange. */
function post(headers: Record<string, string>, body: unknown = INITIALIZE) {
  return SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function setMcpEnabled(mcpEnabled: boolean) {
  const as = { userId: "99999999999999999999999999999999", role: "administrator" } as const;
  const current = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, { as });
  const { revision } = await current.json<{ revision: number }>();
  const response = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, {
    as,
    method: "PUT",
    headers: { "If-Match": `"pat-policy-${revision}"` },
    body: JSON.stringify({
      enabled: true,
      mcpEnabled,
      maxLifetimeDays: null,
      allowedPermissions: null,
    }),
  });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await cleanD1Tables();
  for (const userId of [OWNER, OTHER]) await seedActiveUser(userId);
});
afterEach(cleanD1Tables);

describe("hosted MCP tools", () => {
  it("lists the tools and reads as the token's owner, through the routes they call", async () => {
    const { sessionName: own } = await initSession({ userId: OWNER, title: "Mine" });
    const { sessionName: others } = await initSession({ userId: OTHER, title: "Theirs" });
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(others)
      .run();
    const client = await connect(await issueToken(OWNER, ["sessions.read"]));

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("get_session");

    const listed = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(textOf(listed)).toContain(own);
    expect(textOf(listed)).not.toContain(others);

    const read = await client.callTool({ name: "get_session", arguments: { session_id: own } });
    expect(read.isError).toBeFalsy();
    expect(textOf(read)).toContain("Mine");

    // Another user's private session is not found, exactly as a direct call reports it.
    const hidden = await client.callTool({
      name: "get_session",
      arguments: { session_id: others },
    });
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).toContain("returned 404");
    await client.close();
  });

  it("acts only within the token's grant", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const client = await connect(await issueToken(OWNER, ["automations.read"]));

    const refused = await client.callTool({
      name: "get_session",
      arguments: { session_id: sessionName },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("sessions.read");

    const prompt = await client.callTool({
      name: "send_prompt",
      arguments: { session_id: sessionName, content: "Refused" },
    });
    expect(prompt.isError).toBe(true);
    await client.close();
  });

  it("writes as the token's owner, audited as the same token's direct call is", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);
    const client = await connect(token);

    const sent = await client.callTool({
      name: "send_prompt",
      arguments: { session_id: sessionName, content: "Also handle the timeout case" },
    });
    expect(sent.isError).toBeFalsy();
    expect(
      await queryDO<{ user_id: string; content: string }>(
        stub,
        `SELECT p.user_id, m.content FROM messages m
         JOIN participants p ON p.id = m.author_id`
      )
    ).toEqual([{ user_id: OWNER, content: "Also handle the timeout case" }]);

    const direct = await SELF.fetch(`${BASE}/sessions/${sessionName}/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "And the retry" }),
    });
    expect(direct.status).toBe(200);

    const { results } = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, action, resource_id, metadata_json
         FROM authorization_audit_events
        WHERE action = 'authorization.request_allowed'
        ORDER BY occurred_at, rowid`
    ).all<{
      principal_kind: string;
      actor_user_id_snapshot: string;
      action: string;
      resource_id: string;
      metadata_json: string;
    }>();
    const prompts = results.filter((row) => row.resource_id.endsWith("/prompt"));
    expect(prompts).toHaveLength(2);
    const [viaMcp, viaApi] = prompts.map(({ metadata_json, ...row }) => ({
      ...row,
      metadata: JSON.parse(metadata_json) as Record<string, unknown>,
    }));
    expect(viaMcp).toMatchObject({
      principal_kind: "personal-access-token",
      actor_user_id_snapshot: OWNER,
      resource_id: `/sessions/${sessionName}/prompt`,
    });
    // The MCP call leaves the same record the direct call does.
    expect(viaMcp).toEqual({ ...viaApi, metadata: expect.anything() });
    expect(Object.keys(viaMcp!.metadata).sort()).toEqual(Object.keys(viaApi!.metadata).sort());
    // Nothing is recorded against /mcp itself: it grants nothing.
    expect(results.some((row) => row.resource_id === "/mcp")).toBe(false);
    await client.close();
  });
});

describe("hosted MCP session lifecycle and children", () => {
  it("renames, archives, unarchives, and stops a session as the token's owner, audited to the token", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER, title: "Before" });
    // The test spawn fails on its own; archiving waits on the sandbox, so let that settle first.
    await waitForSandboxStatus(stub, "failed");
    const client = await connect(await issueToken(OWNER, ["sessions.read", "sessions.lifecycle"]));
    const sessions = new SessionIndexStore(env.DB);

    const renamed = await client.callTool({
      name: "rename_session",
      arguments: { session_id: sessionName, title: "  After  " },
    });
    expect(renamed.isError).toBeFalsy();
    expect(JSON.parse(textOf(renamed))).toEqual({ title: "After" });
    expect(await sessions.get(sessionName)).toMatchObject({ title: "After" });

    const archived = await client.callTool({
      name: "archive_session",
      arguments: { session_id: sessionName },
    });
    expect(archived.isError).toBeFalsy();
    expect(JSON.parse(textOf(archived))).toMatchObject({ outcome: "archived" });
    expect(await sessions.get(sessionName)).toMatchObject({ status: "archived" });

    const restored = await client.callTool({
      name: "unarchive_session",
      arguments: { session_id: sessionName },
    });
    expect(restored.isError).toBeFalsy();
    expect((await sessions.get(sessionName))?.status).not.toBe("archived");

    const stopped = await client.callTool({
      name: "stop_session",
      arguments: { session_id: sessionName },
    });
    expect(stopped.isError).toBeFalsy();
    expect(JSON.parse(textOf(stopped))).toEqual({ status: "stopping" });

    const { results } = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, resource_id
         FROM authorization_audit_events
        WHERE action = 'authorization.request_allowed'
        ORDER BY occurred_at, rowid`
    ).all<{ principal_kind: string; actor_user_id_snapshot: string; resource_id: string }>();
    expect(results).toEqual(
      ["title", "archive", "unarchive", "stop"].map((route) => ({
        principal_kind: "personal-access-token",
        actor_user_id_snapshot: OWNER,
        resource_id: `/sessions/${sessionName}/${route}`,
      }))
    );
    await client.close();
  });

  it("refuses the lifecycle tools to a token without sessions.lifecycle, naming it", async () => {
    const { sessionName } = await initSession({ userId: OWNER, title: "Kept" });
    const client = await connect(
      await issueToken(OWNER, ["sessions.read", "sessions.collaborate"])
    );

    for (const name of ["stop_session", "archive_session", "unarchive_session"]) {
      const refused = await client.callTool({ name, arguments: { session_id: sessionName } });
      expect(refused.isError, name).toBe(true);
      expect(textOf(refused), name).toContain("sessions.lifecycle");
    }
    const rename = await client.callTool({
      name: "rename_session",
      arguments: { session_id: sessionName, title: "Refused" },
    });
    expect(rename.isError).toBe(true);
    expect(textOf(rename)).toContain("sessions.lifecycle");
    expect(await new SessionIndexStore(env.DB).get(sessionName)).toMatchObject({
      title: "Kept",
      status: "created",
    });
    await client.close();
  });

  it.each([
    // Under legacy enforcement the route names the permission itself.
    ["off", "permission_required", "This token was not granted sessions.lifecycle"],
    // Under enforced teams the session resolver refuses without naming it, so the tool does.
    [
      "on",
      "missing_permission",
      "This tool needs a token granted sessions.read and sessions.lifecycle",
    ],
  ] as const)(
    "names sessions.lifecycle when a read-only token calls a lifecycle tool (teams %s)",
    async (mode, code, named) => {
      const { sessionName } = await initSession({ userId: OWNER, title: "Kept" });
      const client = await connectIn(mode, await issueToken(OWNER, ["sessions.read"]));

      for (const [name, args] of [
        ["stop_session", {}],
        ["archive_session", {}],
        ["unarchive_session", {}],
        ["rename_session", { title: "Refused" }],
      ] as const) {
        const refused = await client.callTool({
          name,
          arguments: { session_id: sessionName, ...args },
        });
        expect(refused.isError, name).toBe(true);
        expect(textOf(refused), name).toContain("returned 403");
        expect(textOf(refused), name).toContain(code);
        expect(textOf(refused), name).toContain(named);
      }
      // Reading still works with the same token.
      const read = await client.callTool({
        name: "get_session",
        arguments: { session_id: sessionName },
      });
      expect(read.isError).toBeFalsy();
      expect(await new SessionIndexStore(env.DB).get(sessionName)).toMatchObject({
        title: "Kept",
        status: "created",
      });
      await client.close();
    }
  );

  it("lists and reads a session's children, and never another user's private one", async () => {
    const parent = await initSession({ userId: OWNER });
    const child = await initSession({ userId: OWNER, title: "Child task" });
    const hidden = await initSession({ userId: OTHER, title: "Someone else's" });
    for (const id of [child.sessionName, hidden.sessionName]) {
      await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
        .bind(parent.sessionName, id)
        .run();
    }
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(hidden.sessionName)
      .run();
    const client = await connect(await issueToken(OWNER, ["sessions.read"]));

    const listed = await client.callTool({
      name: "list_session_children",
      arguments: { session_id: parent.sessionName },
    });
    expect(listed.isError).toBeFalsy();
    const { children } = JSON.parse(textOf(listed)) as { children: { id: string }[] };
    expect(children.map((entry) => entry.id)).toEqual([child.sessionName]);

    const read = await client.callTool({
      name: "get_session_child",
      arguments: {
        session_id: parent.sessionName,
        child_id: child.sessionName,
        include_result: true,
        trajectory_limit: 10,
      },
    });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(textOf(read))).toMatchObject({
      session: { id: child.sessionName, title: "Child task" },
      finalResponse: null,
      trajectory: { events: [], hasMore: false, limit: 10 },
    });

    const refused = await client.callTool({
      name: "get_session_child",
      arguments: { session_id: parent.sessionName, child_id: hidden.sessionName },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("returned 404");
    await client.close();
  });
});

describe("hosted MCP admission", () => {
  it("requires a live personal access token, and says so with a bearer challenge", async () => {
    const missing = await post({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toMatch(/^Bearer /);

    const unknown = await post({ Authorization: `Bearer oi_pat_${"0".repeat(64)}` });
    expect(unknown.status).toBe(401);

    const token = await issueToken(OWNER, ["sessions.read"]);
    // Revoking deletes the token.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM personal_access_token_permissions"),
      env.DB.prepare("DELETE FROM personal_access_tokens"),
    ]);
    const revoked = await post({ Authorization: `Bearer ${token}` });
    expect(revoked.status).toBe(401);
  });

  it("refuses a validly signed service request, even with a token", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);
    const body = JSON.stringify(INITIALIZE);
    // A genuine signature authenticates the service, not one person, so it is not a token holder.
    const signed = await serviceRequestHeaders(`${BASE}/mcp`, {
      service: "slack-bot",
      method: "POST",
      body,
    });
    const response = await post({ ...signed, Authorization: `Bearer ${token}` }, body);
    expect(response.status).toBe(401);
  });

  it("is not found while the API policy turns MCP off, and serves again once it is on", async () => {
    await seedActiveUser("99999999999999999999999999999999");
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
    )
      .bind("99999999999999999999999999999999")
      .run();
    const token = await issueToken(OWNER, ["sessions.read"]);

    await setMcpEnabled(false);
    expect((await post({ Authorization: `Bearer ${token}` })).status).toBe(404);
    // Without a token too: off reveals nothing about the caller.
    expect((await post({})).status).toBe(404);
    // The API itself keeps accepting the token.
    const direct = await SELF.fetch(`${BASE}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(direct.status).toBe(200);

    await setMcpEnabled(true);
    const client = await connect(token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("refuses a browser origin other than the deployment's own", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);

    const foreign = await post({ Authorization: `Bearer ${token}`, Origin: "https://evil.test" });
    expect(foreign.status).toBe(403);

    const own = await post({
      Authorization: `Bearer ${token}`,
      Origin: new URL(env.WEB_APP_URL!).origin,
    });
    expect(own.status).toBe(200);
  });

  it("refuses an oversized body before parsing it", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);
    const response = await post(
      { Authorization: `Bearer ${token}` },
      JSON.stringify({ ...INITIALIZE, padding: "x".repeat(HOSTED_MCP_MAX_REQUEST_BODY_BYTES) })
    );
    expect(response.status).toBe(413);
  });

  it("takes one message per request: batches and subscriptions are refused", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);
    const list = { jsonrpc: "2.0", method: "tools/list", params: {} };
    const batch = await post(
      { Authorization: `Bearer ${token}` },
      Array.from({ length: 3 }, (_, id) => ({ ...list, id }))
    );
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const listen = await post(
      { Authorization: `Bearer ${token}` },
      { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {} }
    );
    expect(listen.status).toBe(400);
    await expect(listen.json()).resolves.toMatchObject({ error: { code: -32601 } });

    const malformed = await post({ Authorization: `Bearer ${token}` }, "{not json");
    expect(malformed.status).toBe(400);
  });

  it("serves the 2026-07-28 protocol as one JSON response", async () => {
    const { sessionName } = await initSession({ userId: OWNER, title: "Modern" });
    const token = await issueToken(OWNER, ["sessions.read"]);
    const response = await post(
      {
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_session",
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_session",
          arguments: { session_id: sessionName },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "modern", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    const body = await response.json<{
      result: { isError?: boolean; content: { text: string }[] };
    }>();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0]?.text).toContain("Modern");
  });

  it("is stateless: GET and DELETE are not served", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);
    for (const method of ["GET", "DELETE"]) {
      const response = await SELF.fetch(`${BASE}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      });
      expect(response.status).toBe(405);
    }
  });

  it("answers a stateless tools/list that skips initialize", async () => {
    const token = await issueToken(OWNER, ["sessions.read"]);
    const response = await routeRequest(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
      env,
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    // A 2025-era request is answered as a one-message event stream.
    const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    const body = JSON.parse(data!.slice("data: ".length)) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });
});
