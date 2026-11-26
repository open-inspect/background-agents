import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  availableOAuthEndpoints,
  bearerChallenge,
  oauthEndpoints,
  protectedResourceMetadata,
  readOnlyScopes,
} from "./server";

const OPEN = { enabled: true, mcpEnabled: true, maxLifetimeDays: null, allowedPermissions: null };
const ENV = { WEB_APP_URL: "https://app.example", WORKER_URL: "https://cp.example/" };

describe("OAuth endpoints", () => {
  it("makes the web app the issuer and the control plane's /mcp the resource", () => {
    expect(oauthEndpoints(ENV)).toEqual({
      issuer: "https://app.example",
      resource: "https://cp.example/mcp",
      resourceMetadataUrl: "https://cp.example/.well-known/oauth-protected-resource/mcp",
    });
  });

  it.each([
    ["without the web app's URL", { WORKER_URL: ENV.WORKER_URL }],
    ["without the control plane's URL", { WEB_APP_URL: ENV.WEB_APP_URL }],
    ["with a web app URL that is not an origin", { ...ENV, WEB_APP_URL: "https://app.example/x" }],
    ["with an insecure web app URL", { ...ENV, WEB_APP_URL: "http://app.example" }],
    ["with a malformed control plane URL", { ...ENV, WORKER_URL: "not a url" }],
    ["with a control plane on plain HTTP", { ...ENV, WORKER_URL: "http://cp.example" }],
  ])("is unavailable %s", (_label, env) => {
    expect(oauthEndpoints(env)).toBeNull();
  });

  it("allows plain HTTP only for a control plane on a loopback host", () => {
    for (const worker of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      expect(
        oauthEndpoints({ WEB_APP_URL: "http://localhost:3000", WORKER_URL: worker })?.resource
      ).toBe(`${worker}/mcp`);
    }
  });

  it("is unavailable while tokens or MCP clients are off", () => {
    expect(availableOAuthEndpoints(ENV, OPEN)).not.toBeNull();
    expect(availableOAuthEndpoints(ENV, { ...OPEN, enabled: false })).toBeNull();
    expect(availableOAuthEndpoints(ENV, { ...OPEN, mcpEnabled: false })).toBeNull();
  });
});

describe("OAuth metadata", () => {
  const endpoints = oauthEndpoints(ENV)!;

  it("advertises the code flow with PKCE and client metadata documents, without refresh", () => {
    const metadata = authorizationServerMetadata(endpoints, OPEN);
    expect(metadata).toMatchObject({
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.scopes_supported).not.toContain("offline_access");
    expect(metadata.scopes_supported).not.toContain("workspace.members.manage");
  });

  it("asks first for reads only, within the policy's ceiling", () => {
    // The reads the MCP tools use, not every read a token could hold.
    expect(readOnlyScopes(OPEN)).toEqual(["automations.read", "sessions.read", "skills.read"]);
    expect(
      protectedResourceMetadata(endpoints, {
        ...OPEN,
        allowedPermissions: ["sessions.read", "sessions.create"],
      }).scopes_supported
    ).toEqual(["sessions.read"]);
  });
});

describe("bearerChallenge", () => {
  it("points at the resource metadata and names scopes while sign-in is available", () => {
    expect(
      bearerChallenge(oauthEndpoints(ENV), {
        error: "insufficient_scope",
        scope: ["sessions.read", "sessions.collaborate"],
      })
    ).toBe(
      'Bearer realm="open-inspect", error="insufficient_scope", ' +
        'resource_metadata="https://cp.example/.well-known/oauth-protected-resource/mcp", ' +
        'scope="sessions.read sessions.collaborate"'
    );
  });

  it("is a plain challenge without sign-in", () => {
    expect(bearerChallenge(null, { scope: ["sessions.read"] })).toBe('Bearer realm="open-inspect"');
  });
});
