/**
 * OAuth sign-in for the hosted MCP server, through the deployed Worker against real D1: the
 * metadata documents, the consent routes the web app's consent page calls, the token endpoint it
 * forwards, and the issued token used at `/mcp` and directly against the API. Client metadata
 * documents come from the outbound fixture (`test/fixtures/oauth-client-metadata.ts`).
 */

import { createExecutionContext, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  OAuthAuthorizationRequest,
  OAuthConsentResponse,
} from "@open-inspect/shared/types/oauth";
import type { PersonalAccessTokenPolicy } from "@open-inspect/shared/types/personal-access-tokens";
import { hashToken } from "../../src/auth/crypto";
import { OAuthAuthorizationCodeStore } from "../../src/db/oauth-authorization-codes";
import { AutomationStore } from "../../src/db/automation-store";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { STEP_UP_REPLACEMENT_WINDOW_MS } from "../../src/oauth/authorization";
import { s256CodeChallenge } from "../../src/oauth/pkce";
import { TEST_CLIENT_ORIGIN } from "../fixtures/oauth-client-metadata";
import { makeAutomation } from "./invocation-fixtures";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  routeRequest,
  serviceFetch,
  serviceRequestHeaders,
  sqlDatabase,
} from "./helpers";

const BASE = "https://cp.test";
const RESOURCE = `${BASE}/mcp`;
const ISSUER = new URL(env.WEB_APP_URL!).origin;
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const TEST_CLIENT = `${TEST_CLIENT_ORIGIN}/metadata`;
const OWNER = "77777777777777777777777777777777";
const VIEWER = "66666666666666666666666666666666";
const ADMIN = { userId: "99999999999999999999999999999999", role: "administrator" } as const;

/** The deployment as production configures it: the control plane knows its own public URL. */
const deployed = { ...env, WORKER_URL: BASE };

function controlPlane(path: string, init: RequestInit = {}, bindings: typeof env = deployed) {
  return routeRequest(new Request(`${BASE}${path}`, init), bindings, createExecutionContext());
}

/** A consent route, as the web app's consent page calls it for the signed-in user. */
async function asUser(
  path: string,
  body: unknown,
  userId = OWNER,
  role: "owner" | "viewer" = "owner"
) {
  const serialized = JSON.stringify(body);
  const headers = await serviceRequestHeaders(`${BASE}${path}`, {
    method: "POST",
    body: serialized,
    as: { userId, role },
  });
  return controlPlane(path, { method: "POST", headers, body: serialized });
}

/** A web-app-only route, as the web app forwards it. */
async function asWebApp(path: string, init: { method?: string; body?: unknown } = {}) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers = await serviceRequestHeaders(`${BASE}${path}`, { method: init.method, body });
  return controlPlane(path, { method: init.method ?? "GET", headers, body });
}

async function pkce() {
  const verifier = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  return { verifier, challenge: await s256CodeChallenge(verifier) };
}

async function authorizationRequest(
  overrides: Partial<OAuthAuthorizationRequest> = {}
): Promise<{ request: OAuthAuthorizationRequest; verifier: string }> {
  const { verifier, challenge } = await pkce();
  return {
    verifier,
    request: {
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
      state: "state-1",
      scope: "sessions.read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      ...overrides,
    },
  };
}

async function check(request: OAuthAuthorizationRequest, userId = OWNER) {
  const response = await asUser("/oauth/authorize/check", request, userId);
  expect(response.status).toBe(200);
  return response.json<OAuthConsentResponse>();
}

async function approve(
  request: OAuthAuthorizationRequest,
  permissions: PermissionId[] = ["sessions.read"],
  expiresInDays = 30,
  replacesTokenId: string | null = null
) {
  return asUser("/oauth/authorize/approve", {
    request,
    permissions,
    expiresInDays,
    replacesTokenId,
  });
}

/** Approve and return the code the browser would carry back to the client. */
async function approvedCode(
  request: OAuthAuthorizationRequest,
  permissions?: PermissionId[],
  expiresInDays?: number,
  replacesTokenId: string | null = null
): Promise<string> {
  const response = await approve(request, permissions, expiresInDays, replacesTokenId);
  expect(response.status).toBe(200);
  const { redirectUrl } = await response.json<{ redirectUrl: string }>();
  const code = new URL(redirectUrl).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

function exchange(fields: Record<string, string>) {
  return asWebApp("/internal/oauth/token", { method: "POST", body: fields });
}

async function tokenFor(
  request: OAuthAuthorizationRequest,
  verifier: string,
  permissions?: PermissionId[],
  replacesTokenId: string | null = null
): Promise<string> {
  const code = await approvedCode(request, permissions, undefined, replacesTokenId);
  const response = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: request.client_id!,
    redirect_uri: request.redirect_uri!,
    resource: RESOURCE,
  });
  expect(response.status).toBe(200);
  return (await response.json<{ access_token: string }>()).access_token;
}

/** Sign in as Claude with the given grant, returning the issued token. */
async function signIn(permissions: PermissionId[] = ["sessions.read"], client = CLAUDE) {
  const redirect = client === CLAUDE_CODE ? "http://127.0.0.1:43123/callback" : CLAUDE_CALLBACK;
  const { request, verifier } = await authorizationRequest({
    client_id: client,
    redirect_uri: redirect,
    scope: permissions.join(" "),
  });
  return tokenFor(request, verifier, permissions);
}

async function setPolicy(rules: Partial<PersonalAccessTokenPolicy>) {
  const current = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, {
    as: ADMIN,
  });
  const { revision, ...stored } = await current.json<
    PersonalAccessTokenPolicy & { revision: number }
  >();
  const response = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, {
    as: ADMIN,
    method: "PUT",
    headers: { "If-Match": `"pat-policy-${revision}"` },
    body: JSON.stringify({
      enabled: stored.enabled,
      mcpEnabled: stored.mcpEnabled,
      oauthClientIds: stored.oauthClientIds,
      maxLifetimeDays: stored.maxLifetimeDays,
      allowedPermissions: stored.allowedPermissions,
      ...rules,
    }),
  });
  expect(response.status).toBe(200);
}

async function fetchedClientDocuments(): Promise<string[]> {
  return (await fetch(`${TEST_CLIENT_ORIGIN}/__fixture/fetched`)).json();
}

/** A real MCP client on `/mcp` with the given token. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) =>
      routeRequest(
        new Request(url, { ...init, signal: undefined }),
        deployed,
        createExecutionContext()
      ),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "integration", version: "0" });
  await client.connect(transport);
  return client;
}

/** One raw `tools/call` on `/mcp`, to see the HTTP answer rather than a client's reading of it. */
function callTool(token: string, name: string, args: Record<string, unknown>) {
  return controlPlane("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function tokenRows(userId = OWNER) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, oauth_client_id FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at"
  )
    .bind(userId)
    .all<{ id: string; name: string; oauth_client_id: string | null }>();
  return results;
}

/** The row id of a token just issued, found by the token itself, never by position. */
async function rowIdOf(token: string): Promise<string> {
  const found = await new PersonalAccessTokenStore(env.DB).findByToken(token);
  if (!found) throw new Error("token not found");
  return found.id;
}

async function pastedToken(permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId: OWNER,
    name: "pasted",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

beforeEach(async () => {
  await cleanD1Tables();
  await fetch(`${TEST_CLIENT_ORIGIN}/__fixture/reset`);
  // Seed the owner and administrator with their roles.
  await serviceFetch(`${BASE}/personal-access-tokens`, { as: { userId: OWNER, role: "owner" } });
  await serviceFetch(`${BASE}/settings/personal-access-token-policy`, { as: ADMIN });
});
afterEach(cleanD1Tables);

describe("OAuth metadata", () => {
  it("publishes the protected resource metadata for /mcp, pointing at the web app", async () => {
    const response = await controlPlane("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    const metadata = await response.json<Record<string, unknown>>();
    expect(metadata).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      // The reads the MCP tools use, not every read a token could hold.
      scopes_supported: ["automations.read", "sessions.read", "skills.read"],
    });
    // Only reads: writing is asked for by step-up.
    expect(metadata.scopes_supported).not.toContain("sessions.create");
    expect(metadata.scopes_supported).not.toContain("offline_access");
  });

  it("serves the authorization server metadata to the web app", async () => {
    const response = await asWebApp("/internal/oauth/authorization-server-metadata");
    expect(response.status).toBe(200);
    const metadata = await response.json<Record<string, unknown>>();
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.scopes_supported).toContain("sessions.create");
    expect(metadata.scopes_supported).not.toContain("offline_access");
    expect(metadata).not.toHaveProperty("registration_endpoint");
    // Not callable by anyone but the web app.
    expect((await controlPlane("/internal/oauth/authorization-server-metadata")).status).toBe(401);
  });

  it("scopes the metadata to the policy's permission ceiling", async () => {
    await setPolicy({ allowedPermissions: ["sessions.read", "sessions.collaborate"] });
    const resource = await (
      await controlPlane("/.well-known/oauth-protected-resource/mcp")
    ).json<{ scopes_supported: string[] }>();
    expect(resource.scopes_supported).toEqual(["sessions.read"]);
    const server = await (
      await asWebApp("/internal/oauth/authorization-server-metadata")
    ).json<{ scopes_supported: string[] }>();
    expect(server.scopes_supported).toEqual(["sessions.collaborate", "sessions.read"].sort());
  });

  it("is absent without the deployment's public URLs", async () => {
    const unconfigured = { ...env, WORKER_URL: undefined };
    const response = await controlPlane(
      "/.well-known/oauth-protected-resource/mcp",
      {},
      unconfigured
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "OAuth sign-in is not available" });
    const unauthenticated = await controlPlane("/mcp", { method: "POST" }, unconfigured);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toBe('Bearer realm="open-inspect"');
  });

  it("challenges an unauthenticated /mcp request with the resource metadata and read scopes", async () => {
    const missing = await controlPlane("/mcp", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    const challenge = missing.headers.get("WWW-Authenticate")!;
    expect(challenge).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`
    );
    expect(challenge).toMatch(/scope="[^"]*sessions\.read[^"]*"/);
    expect(challenge).not.toContain("error=");

    const unknown = await controlPlane("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer oi_pat_${"0".repeat(64)}` },
      body: "{}",
    });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });
});

describe("OAuth sign-in", () => {
  it("signs in, issues a token, and the token works at /mcp and against the API", async () => {
    const { sessionName } = await initSession({ userId: OWNER, title: "Signed in" });
    const { request, verifier } = await authorizationRequest();

    const consent = await check(request);
    expect(consent).toMatchObject({
      kind: "consent",
      client: { id: CLAUDE, host: "claude.ai" },
      redirect: { host: "claude.ai", loopback: false },
      requested: ["sessions.read"],
      maxLifetimeDays: 365,
      replaces: null,
    });
    if (consent.kind !== "consent") throw new Error("unreachable");
    expect(consent.grantable).toContain("sessions.create");
    const deny = new URL(consent.denyUrl);
    expect(`${deny.origin}${deny.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(Object.fromEntries(deny.searchParams)).toEqual({
      error: "access_denied",
      state: "state-1",
      iss: ISSUER,
    });

    const approved = await approve(request, ["sessions.read"], 30);
    expect(approved.status).toBe(200);
    const { redirectUrl } = await approved.json<{ redirectUrl: string }>();
    const back = new URL(redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    const code = back.searchParams.get("code")!;
    // Only a hash of the code is kept.
    const stored = await env.DB.prepare("SELECT code_hash FROM oauth_authorization_codes").all();
    expect(JSON.stringify(stored.results)).not.toContain(code);

    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
      resource: RESOURCE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const token = await response.json<{
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
      refresh_token?: string;
    }>();
    expect(token).toEqual({
      access_token: expect.stringMatching(/^oi_pat_[0-9a-f]{64}$/),
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      scope: "sessions.read",
    });
    expect(token.refresh_token).toBeUndefined();
    // An ordinary token row, recorded as issued to the client.
    expect(await tokenRows()).toEqual([
      { id: expect.any(String), name: "Claude (claude.ai)", oauth_client_id: CLAUDE },
    ]);

    const client = await connect(token.access_token);
    const read = await client.callTool({
      name: "get_session",
      arguments: { session_id: sessionName },
    });
    expect(read.isError).toBeFalsy();
    await client.close();

    const direct = await controlPlane(`/sessions/${sessionName}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(direct.status).toBe(200);
  });

  it("accepts Claude Code's loopback redirect on any port, by 127.0.0.1 or localhost", async () => {
    for (const redirect of ["http://127.0.0.1:43123/callback", "http://localhost:8/callback"]) {
      const { request } = await authorizationRequest({
        client_id: CLAUDE_CODE,
        redirect_uri: redirect,
      });
      await expect(check(request)).resolves.toMatchObject({
        kind: "consent",
        client: { host: "claude.ai" },
        redirect: { loopback: true },
      });
    }
    // The path must still match.
    const { request } = await authorizationRequest({
      client_id: CLAUDE_CODE,
      redirect_uri: "http://127.0.0.1:43123/elsewhere",
    });
    await expect(check(request)).resolves.toMatchObject({
      kind: "error",
      code: "oauth_redirect_uri_invalid",
    });
  });

  it("refuses an exchange whose PKCE verifier does not match, and spends the code", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    const fields = {
      grant_type: "authorization_code",
      code,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    };

    const wrong = await exchange({ ...fields, code_verifier: (await pkce()).verifier });
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ error: "invalid_grant" });
    // The right verifier is too late: the code was claimed by the first attempt.
    const late = await exchange({ ...fields, code_verifier: verifier });
    await expect(late.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("requires PKCE S256 on the authorization request, and says so to the client", async () => {
    for (const overrides of [
      { code_challenge: undefined },
      { code_challenge_method: "plain" },
      { code_challenge: "too-short" },
    ]) {
      const { request } = await authorizationRequest(overrides);
      const consent = await check(request);
      expect(consent.kind).toBe("redirect");
      if (consent.kind !== "redirect") continue;
      const back = new URL(consent.url);
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("iss")).toBe(ISSUER);
    }
  });

  it("sends a malformed request back to a verified client, naming the issuer", async () => {
    for (const [overrides, error] of [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://elsewhere.test/mcp" }, "invalid_target"],
    ] as const) {
      const { request } = await authorizationRequest(overrides);
      const consent = await check(request);
      expect(consent.kind).toBe("redirect");
      if (consent.kind !== "redirect") continue;
      const back = new URL(consent.url);
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
      expect(back.searchParams.get("error")).toBe(error);
      expect(back.searchParams.get("state")).toBe("state-1");
      expect(back.searchParams.get("iss")).toBe(ISSUER);
      expect((await approve(request)).status).toBe(400);
    }
    // A client that names no resource means the hosted MCP server.
    const { request } = await authorizationRequest({ resource: undefined });
    await expect(check(request)).resolves.toMatchObject({ kind: "consent" });
  });

  it("refuses an exchange for another resource than the code's", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
      resource: "https://elsewhere.test/mcp",
    });
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_target" });
    expect(await tokenRows()).toEqual([]);
  });

  it("refuses an exchange once the API policy has changed since approval", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    await setPolicy({ maxLifetimeDays: 7 });
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("issues nothing for a code replayed before its first exchange finished", async () => {
    const { request } = await authorizationRequest();
    const code = await approvedCode(request);
    const codes = new OAuthAuthorizationCodeStore(sqlDatabase(env.DB));
    const codeHash = await hashToken(code);
    const first = await codes.claim(codeHash, Date.now());
    if (first.kind !== "claimed") throw new Error("the code was not claimed");
    // The replay lands between the first exchange's claim and its issue.
    await expect(codes.claim(codeHash, Date.now())).resolves.toMatchObject({
      kind: "replayed",
      issuedTokenId: null,
    });
    const issued = await new PersonalAccessTokenStore(env.DB).issue({
      userId: OWNER,
      name: "late",
      permissions: first.code.permissions,
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
      requestId: "integration",
      policyRevision: first.code.policyRevision,
      oauth: { clientId: CLAUDE, codeHash, replacesTokenId: null, expiredTokenIds: [] },
    });
    expect(issued.kind).toBe("code_unavailable");
    expect(await tokenRows()).toEqual([]);
  });

  it("refuses a redirect URI the client did not register, without redirecting to it", async () => {
    for (const redirect of [
      "https://evil.test/callback",
      `${CLAUDE_CALLBACK}?extra=1`,
      undefined,
    ]) {
      const { request } = await authorizationRequest({ redirect_uri: redirect });
      await expect(check(request)).resolves.toMatchObject({
        kind: "error",
        code: "oauth_redirect_uri_invalid",
      });
      expect((await approve(request)).status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT 1 FROM oauth_authorization_codes").all()).toMatchObject({
      results: [],
    });
  });

  it("refuses a registered redirect URI on another origin than the client's", async () => {
    await setPolicy({ oauthClientIds: [TEST_CLIENT] });
    const { request } = await authorizationRequest({
      client_id: TEST_CLIENT,
      redirect_uri: "https://elsewhere.test/callback",
    });
    await expect(check(request)).resolves.toMatchObject({
      kind: "error",
      code: "oauth_redirect_uri_invalid",
    });
  });

  it("refuses an exchange with a different redirect URI or client than the code's", async () => {
    const { request, verifier } = await authorizationRequest();
    for (const changed of [
      { redirect_uri: "https://claude.ai/api/mcp/other" },
      { client_id: CLAUDE_CODE },
    ]) {
      const code = await approvedCode(request);
      const response = await exchange({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLAUDE,
        redirect_uri: CLAUDE_CALLBACK,
        ...changed,
      });
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    }
    expect(await tokenRows()).toEqual([]);
  });

  it("refuses a client the policy does not list, without fetching its document", async () => {
    const { request } = await authorizationRequest({
      client_id: TEST_CLIENT,
      redirect_uri: `${TEST_CLIENT_ORIGIN}/callback`,
    });
    await expect(check(request)).resolves.toMatchObject({
      kind: "error",
      code: "oauth_client_untrusted",
    });
    expect((await approve(request)).status).toBe(400);
    expect(await fetchedClientDocuments()).toEqual([]);

    // Once an administrator lists it, it signs in, identified by its host.
    await setPolicy({ oauthClientIds: [TEST_CLIENT] });
    await expect(check(request)).resolves.toMatchObject({
      kind: "consent",
      client: { id: TEST_CLIENT, host: "client.test", name: "Definitely Claude" },
    });
    // The document's own name is shown only beside the host it is served from.
    // Replacing the defaults removes Claude.
    await expect(check((await authorizationRequest()).request)).resolves.toMatchObject({
      kind: "error",
      code: "oauth_client_untrusted",
    });
  });

  it("refuses a listed client whose document is not valid", async () => {
    const documents = ["redirecting", "impostor", "oversized", "confidential", "missing"].map(
      (name) => `${TEST_CLIENT_ORIGIN}/${name}`
    );
    await setPolicy({ oauthClientIds: documents });
    for (const clientId of documents) {
      const { request } = await authorizationRequest({
        client_id: clientId,
        redirect_uri: `${TEST_CLIENT_ORIGIN}/callback`,
      });
      await expect(check(request), clientId).resolves.toMatchObject({
        kind: "error",
        code: "oauth_client_metadata_invalid",
      });
    }
    // A redirect is not followed.
    expect(await fetchedClientDocuments()).not.toContain(TEST_CLIENT);
  });

  it("revokes the issued token when its code is presented again", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    const fields = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    };
    const first = await exchange(fields);
    const { access_token: token } = await first.json<{ access_token: string }>();
    expect(
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status
    ).toBe(200);

    const replay = await exchange(fields);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
    expect(
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status
    ).toBe(401);
    // Recorded as a replay, not as the owner revoking it.
    const revoked = await env.DB.prepare(
      `SELECT reason_code FROM authorization_audit_events
        WHERE action = 'personal_access_token.revoked'`
    ).all<{ reason_code: string }>();
    expect(revoked.results).toEqual([{ reason_code: "oauth_code_replayed" }]);
  });

  it("refuses a malformed verifier even when it answers the challenge", async () => {
    const verifier = "too-short";
    const { request } = await authorizationRequest({
      code_challenge: await s256CodeChallenge(verifier),
    });
    const code = await approvedCode(request);
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("refuses the exchange once the deployment's URLs are gone", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    const headers = await serviceRequestHeaders(`${BASE}/internal/oauth/token`, {
      method: "POST",
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLAUDE,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    });
    const response = await controlPlane(
      "/internal/oauth/token",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: CLAUDE,
          redirect_uri: CLAUDE_CALLBACK,
        }),
      },
      { ...env, WORKER_URL: undefined }
    );
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("prunes the client's expired tokens, so they never fill the cap", async () => {
    const expired = await signIn(["sessions.read"]);
    const expiredRow = { id: await rowIdOf(expired) };
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiredRow.id)
      .run();
    // Expired tokens of another client, and one made in Settings, are not this client's to prune.
    const otherClient = { id: await rowIdOf(await signIn(["sessions.read"], CLAUDE_CODE)) };
    const settings = { id: await rowIdOf(await pastedToken(["sessions.read"])) };
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = ? WHERE id IN (?, ?)")
      .bind(Date.now() - 1, otherClient.id, settings.id)
      .run();
    // The user now holds 50 tokens: at the cap, unless this client's expired one is not counted.
    for (let index = 0; index < 47; index++) await pastedToken(["sessions.read"]);

    const fresh = await signIn(["sessions.read"]);
    const rows = await tokenRows();
    expect(rows).toHaveLength(50);
    expect(rows.map((row) => row.id)).not.toContain(expiredRow.id);
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([otherClient.id, settings.id])
    );
    const pruned = await env.DB.prepare(
      `SELECT resource_id, reason_code FROM authorization_audit_events
        WHERE action = 'personal_access_token.revoked'`
    ).all();
    expect(pruned.results).toEqual([
      { resource_id: expiredRow.id, reason_code: "oauth_expired_pruned" },
    ]);
    const live = async (token: string) =>
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status;
    expect(await live(expired)).toBe(401);
    expect(await live(fresh)).toBe(200);
  });

  it("prunes nothing when the issue it belongs to fails", async () => {
    const expired = await signIn(["sessions.read"]);
    const expiredId = await rowIdOf(expired);
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiredId)
      .run();
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    // The policy moves between approval and exchange, so the insert is refused.
    await setPolicy({ maxLifetimeDays: 90 });
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect((await tokenRows()).map((row) => row.id)).toEqual([expiredId]);
    const pruned = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'personal_access_token.revoked'"
    ).first<{ count: number }>();
    expect(pruned?.count).toBe(0);
  });

  it("refuses an expired code", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    await env.DB.prepare("UPDATE oauth_authorization_codes SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("caps the lifetime chosen at consent at the policy's maximum", async () => {
    await setPolicy({ maxLifetimeDays: 7 });
    const { request, verifier } = await authorizationRequest();
    await expect(check(request)).resolves.toMatchObject({ kind: "consent", maxLifetimeDays: 7 });

    const tooLong = await approve(request, ["sessions.read"], 30);
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ code: "lifetime_exceeds_policy" });

    const code = await approvedCode(request, ["sessions.read"], 7);
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(response.json()).resolves.toMatchObject({ expires_in: 7 * 24 * 60 * 60 });
  });

  it("checks the grant when the user approves, so refusals show on the consent page", async () => {
    const { request } = await authorizationRequest();
    const withheld = await approve(request, ["workspace.members.manage"]);
    expect(withheld.status).toBe(400);
    await expect(withheld.json()).resolves.toMatchObject({ code: "permission_not_grantable" });
    const missingPrerequisite = await approve(request, ["sessions.collaborate"]);
    await expect(missingPrerequisite.json()).resolves.toMatchObject({
      code: "permission_prerequisite_missing",
    });

    // At the per-user cap, approving says so rather than leaving the client an invalid_grant.
    for (let index = 0; index < 50; index++) await pastedToken(["sessions.read"]);
    const capped = await approve(request);
    expect(capped.status).toBe(409);
    await expect(capped.json()).resolves.toMatchObject({
      code: "personal_access_token_limit_reached",
    });
  });

  it("refuses the exchange once the user is suspended", async () => {
    const { request, verifier } = await authorizationRequest();
    const code = await approvedCode(request);
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), OWNER)
      .run();
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual([]);
  });

  it("refuses a token request that is not an authorization code exchange", async () => {
    const refresh = await exchange({ grant_type: "refresh_token", refresh_token: "x" });
    await expect(refresh.json()).resolves.toMatchObject({ error: "unsupported_grant_type" });
    const incomplete = await exchange({ grant_type: "authorization_code", code: "x" });
    await expect(incomplete.json()).resolves.toMatchObject({ error: "invalid_request" });
    const unknown = await exchange({
      grant_type: "authorization_code",
      code: "unknown",
      code_verifier: (await pkce()).verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(unknown.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });
});

describe("OAuth step-up", () => {
  it("answers a write with insufficient_scope naming every scope the connection needs", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await signIn(["sessions.read", "automations.read"]);

    const response = await callTool(token, "send_prompt", {
      session_id: sessionName,
      content: "Write something",
    });
    expect(response.status).toBe(403);
    const challenge = response.headers.get("WWW-Authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`
    );
    const scope = /scope="([^"]*)"/.exec(challenge)![1].split(" ");
    // What it holds, plus what the call needs.
    expect(scope.sort()).toEqual(["automations.read", "sessions.collaborate", "sessions.read"]);

    // A read it holds is served as usual.
    const read = await callTool(token, "get_session", { session_id: sessionName });
    expect(read.status).toBe(200);
  });

  it("names a call's target in the scope it asks for", async () => {
    const token = await signIn(["sessions.read"]);
    const response = await callTool(token, "create_session", {
      prompt: "Start",
      environment_id: "env_1",
    });
    expect(response.status).toBe(403);
    const scope = /scope="([^"]*)"/.exec(response.headers.get("WWW-Authenticate")!)![1];
    expect(scope.split(" ")).toEqual(
      expect.arrayContaining(["sessions.create", "sessions.collaborate", "environments.use"])
    );
    expect(scope.split(" ")).not.toContain("repositories.use");
  });

  it("gives a pasted token a tool error rather than a challenge", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await pastedToken(["sessions.read"]);
    const response = await callTool(token, "send_prompt", {
      session_id: sessionName,
      content: "Write something",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"isError":true');
    expect(text).toContain("sessions.collaborate");
  });

  it("does not challenge for a permission the policy would not let the user grant", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await signIn(["sessions.read"]);
    await setPolicy({ allowedPermissions: ["sessions.read"] });
    const response = await callTool(token, "send_prompt", {
      session_id: sessionName,
      content: "Write something",
    });
    // A challenge would send the user round the same refusal; the tool says what is missing.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"isError":true');
  });

  it("replaces exactly the token that was asked to step up, not another device's", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    // Two devices running the same app, one client id between them.
    const deviceA = await signIn(["sessions.read"], CLAUDE_CODE);
    const deviceB = await signIn(["sessions.read"], CLAUDE_CODE);
    const claude = await signIn(["sessions.read"]);
    const pasted = await pastedToken(["sessions.read"]);
    const rowA = { id: await rowIdOf(deviceA) };
    const rowB = { id: await rowIdOf(deviceB) };
    // B was used last, so "most recently used" would pick B; only the challenge decides.
    await env.DB.prepare("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now() + 60_000, rowB.id)
      .run();

    // Device A is refused a write, which marks its token.
    const refused = await callTool(deviceA, "send_prompt", {
      session_id: sessionName,
      content: "Write something",
    });
    expect(refused.status).toBe(403);

    const { request, verifier } = await authorizationRequest({
      client_id: CLAUDE_CODE,
      redirect_uri: "http://127.0.0.1:43123/callback",
      scope: "sessions.read sessions.collaborate",
    });
    await expect(check(request)).resolves.toMatchObject({
      kind: "consent",
      replaces: {
        id: rowA.id,
        name: "Claude Code (claude.ai)",
        displayPrefix: deviceA.slice(0, "oi_pat_".length + 6),
      },
    });
    const steppedUp = await tokenFor(
      request,
      verifier,
      ["sessions.read", "sessions.collaborate"],
      rowA.id
    );

    const live = async (token: string) =>
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status;
    expect(await live(deviceA)).toBe(401);
    for (const token of [deviceB, claude, pasted, steppedUp]) expect(await live(token)).toBe(200);
    const replaced = await env.DB.prepare(
      `SELECT resource_id, reason_code FROM authorization_audit_events
        WHERE action = 'personal_access_token.revoked'`
    ).all();
    expect(replaced.results).toEqual([
      { resource_id: rowA.id, reason_code: "oauth_step_up_replaced" },
    ]);
  });

  it("replaces nothing when no token was asked to step up, or the user grants reads alone", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const first = await signIn(["sessions.read"]);
    const row = { id: await rowIdOf(first) };
    const stepUpRequest = async () =>
      (await authorizationRequest({ scope: "sessions.read sessions.collaborate" })).request;

    // Without a challenge from /mcp, a request for writes replaces nothing.
    await expect(check(await stepUpRequest())).resolves.toMatchObject({ replaces: null });

    await callTool(first, "send_prompt", { session_id: sessionName, content: "x" });
    const request = await stepUpRequest();
    await expect(check(request)).resolves.toMatchObject({ replaces: { id: row.id } });
    // Choosing reads on the step-up consent replaces nothing, and must say so.
    expect((await approve(request, ["sessions.read"], 30, row.id)).status).toBe(409);
    expect((await approve(request, ["sessions.read"], 30, null)).status).toBe(200);
    // A write grant must name the token the page showed.
    const changed = await approve(request, ["sessions.read", "sessions.collaborate"], 30, null);
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({ code: "oauth_replacement_changed" });

    // Past the window, a challenge no longer decides anything.
    await env.DB.prepare(
      "UPDATE personal_access_tokens SET oauth_step_up_requested_at = ? WHERE id = ?"
    )
      .bind(Date.now() - STEP_UP_REPLACEMENT_WINDOW_MS - 1, row.id)
      .run();
    await expect(check(await stepUpRequest())).resolves.toMatchObject({ replaces: null });

    // Nor does an expired token's.
    await env.DB.prepare(
      "UPDATE personal_access_tokens SET oauth_step_up_requested_at = ?, expires_at = ? WHERE id = ?"
    )
      .bind(Date.now(), Date.now() - 1, row.id)
      .run();
    await expect(check(await stepUpRequest())).resolves.toMatchObject({ replaces: null });
  });

  it("never replaces a token made in Settings or another client's, whatever it is asked", async () => {
    const pasted = await pastedToken(["sessions.read"]);
    const otherClient = await signIn(["sessions.read"], CLAUDE_CODE);
    const pastedRow = { id: await rowIdOf(pasted) };
    const otherRow = { id: await rowIdOf(otherClient) };
    const store = new PersonalAccessTokenStore(env.DB);
    for (const target of [pastedRow.id, otherRow.id]) {
      const { request } = await authorizationRequest();
      const code = await approvedCode(request);
      const issued = await store.issue({
        userId: OWNER,
        name: "step-up",
        permissions: ["sessions.read"],
        expiresAt: Date.now() + 60_000,
        now: Date.now(),
        requestId: "integration",
        oauth: {
          clientId: CLAUDE,
          codeHash: await hashToken(code),
          replacesTokenId: target,
          expiredTokenIds: [],
        },
      });
      expect(issued.kind).toBe("issued");
    }
    const live = async (token: string) =>
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status;
    expect(await live(pasted)).toBe(200);
    expect(await live(otherClient)).toBe(200);
    // Nothing was recorded as revoked either.
    const revoked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'personal_access_token.revoked'"
    ).first<{ count: number }>();
    expect(revoked?.count).toBe(0);
  });

  it("does not let an ineligible replacement free a place under the cap", async () => {
    const settings = await pastedToken(["sessions.read"]);
    for (let index = 0; index < 49; index++) await pastedToken(["sessions.read"]);
    // Approval refuses at the cap, so the code an exchange would present is written directly.
    const codeHash = await hashToken("at-the-cap");
    await env.DB.prepare(
      `INSERT INTO oauth_authorization_codes
         (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, permissions_json,
          expires_in_days, token_name, policy_revision, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'x', ?, '["sessions.read"]', 1, 'x', 0, ?, ?)`
    )
      .bind(codeHash, OWNER, CLAUDE, CLAUDE_CALLBACK, RESOURCE, Date.now(), Date.now() + 60_000)
      .run();
    const issued = await new PersonalAccessTokenStore(env.DB).issue({
      userId: OWNER,
      name: "step-up",
      permissions: ["sessions.read"],
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
      requestId: "integration",
      oauth: {
        clientId: CLAUDE,
        codeHash,
        replacesTokenId: await rowIdOf(settings),
        expiredTokenIds: [],
      },
    });
    // The Settings token is not the client's to replace, so it still counts, and stays.
    expect(issued.kind).toBe("limit_reached");
    expect(await tokenRows()).toHaveLength(50);
    expect((await tokenRows()).map((row) => row.id)).toContain(await rowIdOf(settings));
  });

  it("replaces none when more than one of the client's tokens was asked to step up", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const deviceA = await signIn(["sessions.read"], CLAUDE_CODE);
    const deviceB = await signIn(["sessions.read"], CLAUDE_CODE);
    for (const token of [deviceA, deviceB]) {
      const refused = await callTool(token, "send_prompt", {
        session_id: sessionName,
        content: "x",
      });
      expect(refused.status).toBe(403);
    }
    // Nothing tells the sign-in which device is asking, so it replaces neither.
    const { request, verifier } = await authorizationRequest({
      client_id: CLAUDE_CODE,
      redirect_uri: "http://127.0.0.1:43123/callback",
      scope: "sessions.read sessions.collaborate",
    });
    await expect(check(request)).resolves.toMatchObject({ kind: "consent", replaces: null });
    await tokenFor(request, verifier, ["sessions.read", "sessions.collaborate"], null);
    const live = async (token: string) =>
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status;
    expect(await live(deviceA)).toBe(200);
    expect(await live(deviceB)).toBe(200);
  });

  it("never replaces a token another client was asked to step up from", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const claude = await signIn(["sessions.read"]);
    const refused = await callTool(claude, "send_prompt", {
      session_id: sessionName,
      content: "x",
    });
    expect(refused.status).toBe(403);
    // Claude Code signs in for writes; Claude's challenged token is not its to replace.
    const { request, verifier } = await authorizationRequest({
      client_id: CLAUDE_CODE,
      redirect_uri: "http://127.0.0.1:43123/callback",
      scope: "sessions.read sessions.collaborate",
    });
    await expect(check(request)).resolves.toMatchObject({ kind: "consent", replaces: null });
    await tokenFor(request, verifier, ["sessions.read", "sessions.collaborate"], null);
    expect(
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${claude}` } })).status
    ).toBe(200);
  });

  it("gives a call with invalid arguments the tool's error, not a step-up", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await signIn(["sessions.read"]);
    // send_prompt needs content: no grant would make this call succeed.
    const response = await callTool(token, "send_prompt", { session_id: sessionName });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"isError":true');
    const stamped = await env.DB.prepare(
      "SELECT oauth_step_up_requested_at AS at FROM personal_access_tokens WHERE id = ?"
    )
      .bind(await rowIdOf(token))
      .first<{ at: number | null }>();
    expect(stamped?.at).toBeNull();
  });

  it("examines only a JSON-RPC 2.0 tools/call for step-up", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await signIn(["sessions.read"]);
    const call = (envelope: Record<string, unknown>) =>
      controlPlane("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          ...envelope,
          id: 1,
          method: "tools/call",
          params: { name: "send_prompt", arguments: { session_id: sessionName, content: "x" } },
        }),
      });
    const stampedAt = async () =>
      (
        await env.DB.prepare(
          "SELECT oauth_step_up_requested_at AS at FROM personal_access_tokens WHERE id = ?"
        )
          .bind(await rowIdOf(token))
          .first<{ at: number | null }>()
      )?.at ?? null;

    // Without the envelope it is not a tool call: the MCP handler refuses it, and nothing is marked.
    const malformed = await call({});
    expect(malformed.status).not.toBe(403);
    expect(await stampedAt()).toBeNull();
    const notTwo = await call({ jsonrpc: "1.0" });
    expect(notTwo.status).not.toBe(403);
    expect(await stampedAt()).toBeNull();

    const wellFormed = await call({ jsonrpc: "2.0" });
    expect(wellFormed.status).toBe(403);
    expect(await stampedAt()).not.toBeNull();
  });

  it("asks for automations.read when the token cannot read the automation it triggers", async () => {
    const automationId = "automation-unreadable";
    await new AutomationStore(env.DB).create(
      makeAutomation({ id: automationId, created_by: OWNER, user_id: OWNER })
    );
    const token = await signIn(["automations.trigger.own", "sessions.create"]);
    const response = await callTool(token, "trigger_automation", { automation_id: automationId });
    expect(response.status).toBe(403);
    const scope = /scope="([^"]*)"/.exec(response.headers.get("WWW-Authenticate")!)![1].split(" ");
    expect(scope).toEqual(
      expect.arrayContaining(["automations.read", "automations.trigger.own", "sessions.create"])
    );

    // A pasted token with the same grant is never asked; the trigger route answers it.
    const pasted = await pastedToken(["automations.trigger.own", "sessions.create"]);
    const refused = await callTool(pasted, "trigger_automation", { automation_id: automationId });
    expect(refused.status).toBe(200);
  });

  it("asks to step up to an automation's target use when triggering it", async () => {
    const automationId = "automation-step-up";
    await new AutomationStore(env.DB).create(
      makeAutomation({ id: automationId, created_by: OWNER, user_id: OWNER })
    );
    await env.DB.prepare(
      `INSERT INTO automation_repositories
         (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
       VALUES (?, 'acme', 'web-app', 12345, NULL, ?, ?)`
    )
      .bind(automationId, Date.now(), Date.now())
      .run();
    const token = await signIn([
      "automations.read",
      "automations.trigger.own",
      "sessions.create",
      "sessions.read",
    ]);
    const response = await callTool(token, "trigger_automation", { automation_id: automationId });
    expect(response.status).toBe(403);
    const scope = /scope="([^"]*)"/.exec(response.headers.get("WWW-Authenticate")!)![1].split(" ");
    expect(scope).toContain("repositories.use");
  });

  it("does not challenge for a permission the owner does not hold", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    // Sign in as a viewer, who can read sessions but not collaborate.
    const { request, verifier } = await authorizationRequest();
    const approved = await asUser(
      "/oauth/authorize/approve",
      { request, permissions: ["sessions.read"], expiresInDays: 7, replacesTokenId: null },
      VIEWER,
      "viewer"
    );
    expect(approved.status).toBe(200);
    const { redirectUrl } = await approved.json<{ redirectUrl: string }>();
    const response = await exchange({
      grant_type: "authorization_code",
      code: new URL(redirectUrl).searchParams.get("code")!,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    const { access_token: token } = await response.json<{ access_token: string }>();
    const prompt = await callTool(token, "send_prompt", {
      session_id: sessionName,
      content: "Write something",
    });
    // The user could not grant it, so signing in again would only end at the same refusal.
    expect(prompt.status).toBe(200);
    expect(await prompt.text()).toContain('"isError":true');
  });
});

describe("OAuth and the API policy's MCP switch", () => {
  it("stops sign-in and every token issued through it while MCP clients are off", async () => {
    const oauthToken = await signIn(["sessions.read"]);
    const pasted = await pastedToken(["sessions.read"]);
    const { request, verifier } = await authorizationRequest();
    const pendingCode = await approvedCode(request);

    await setPolicy({ mcpEnabled: false });
    expect((await controlPlane("/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
    expect((await asWebApp("/internal/oauth/authorization-server-metadata")).status).toBe(404);
    await expect(check(request)).resolves.toMatchObject({
      kind: "error",
      code: "oauth_unavailable",
    });
    const exchanged = await exchange({
      grant_type: "authorization_code",
      code: pendingCode,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CALLBACK,
    });
    await expect(exchanged.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const api = (token: string) =>
      controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } });
    // A token issued to an app stops everywhere; one made in Settings keeps working with the API.
    expect((await api(oauthToken)).status).toBe(401);
    expect((await api(pasted)).status).toBe(200);

    await setPolicy({ mcpEnabled: true });
    expect((await api(oauthToken)).status).toBe(200);
  });

  it("stops a client's tokens once the API policy no longer lists it", async () => {
    const claude = await signIn(["sessions.read"]);
    const claudeCode = await signIn(["sessions.read"], CLAUDE_CODE);
    const live = async (token: string) =>
      (await controlPlane("/sessions", { headers: { Authorization: `Bearer ${token}` } })).status;

    await setPolicy({ oauthClientIds: [CLAUDE_CODE] });
    expect(await live(claude)).toBe(401);
    expect(await live(claudeCode)).toBe(200);
    await setPolicy({ oauthClientIds: null });
    expect(await live(claude)).toBe(200);
  });

  it("explains on the consent page that tokens are off", async () => {
    await setPolicy({ enabled: false });
    await expect(check((await authorizationRequest()).request)).resolves.toMatchObject({
      kind: "error",
      code: "personal_access_tokens_disabled",
    });
  });
});
