/**
 * Client ID metadata documents for OAuth sign-in tests, served from the integration runtime's
 * outbound fetch. Records every document fetched, so a test can tell what was never fetched.
 * Never used by production code.
 */

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

/** The origin of the documents a test adds to the API policy itself. */
export const TEST_CLIENT_ORIGIN = "https://client.test";

export class OAuthClientMetadataFixture {
  readonly fetched: string[] = [];

  handles(url: URL): boolean {
    return url.origin === TEST_CLIENT_ORIGIN || url.href === CLAUDE || url.href === CLAUDE_CODE;
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/fetched") return Response.json(this.fetched);
    if (url.pathname === "/__fixture/reset") {
      this.fetched.length = 0;
      return Response.json({ ok: true });
    }
    this.fetched.push(url.href);
    switch (url.href) {
      case CLAUDE:
        return Response.json({
          client_id: CLAUDE,
          client_name: "Claude",
          client_uri: "https://claude.ai",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      case CLAUDE_CODE:
        return Response.json({
          client_id: CLAUDE_CODE,
          client_name: "Claude Code",
          client_uri: "https://claude.ai",
          redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      case `${TEST_CLIENT_ORIGIN}/metadata`:
        return Response.json({
          client_id: `${TEST_CLIENT_ORIGIN}/metadata`,
          // Self-asserted: consent must name the host, not this.
          client_name: "Definitely Claude",
          redirect_uris: [`${TEST_CLIENT_ORIGIN}/callback`, "https://elsewhere.test/callback"],
        });
      case `${TEST_CLIENT_ORIGIN}/redirecting`:
        return new Response(null, {
          status: 302,
          headers: { Location: `${TEST_CLIENT_ORIGIN}/metadata` },
        });
      case `${TEST_CLIENT_ORIGIN}/impostor`:
        return Response.json({
          client_id: `${TEST_CLIENT_ORIGIN}/metadata`,
          redirect_uris: [`${TEST_CLIENT_ORIGIN}/callback`],
        });
      case `${TEST_CLIENT_ORIGIN}/oversized`:
        return Response.json({
          client_id: `${TEST_CLIENT_ORIGIN}/oversized`,
          redirect_uris: [`${TEST_CLIENT_ORIGIN}/callback`],
          padding: "x".repeat(10_000),
        });
      case `${TEST_CLIENT_ORIGIN}/confidential`:
        return Response.json({
          client_id: `${TEST_CLIENT_ORIGIN}/confidential`,
          redirect_uris: [`${TEST_CLIENT_ORIGIN}/callback`],
          token_endpoint_auth_method: "client_secret_basic",
        });
      default:
        return new Response("Not found", { status: 404 });
    }
  }
}
