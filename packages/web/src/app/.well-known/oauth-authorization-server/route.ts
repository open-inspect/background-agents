import {
  forwardToControlPlane,
  OAUTH_RESPONSE_HEADERS,
  relayOAuthResponse,
} from "@/lib/oauth-server";

export const dynamic = "force-dynamic";

/**
 * RFC 8414 authorization server metadata for this origin, the issuer of MCP clients' sign-in. The
 * control plane builds it from the API policy, and answers 404 while sign-in is unavailable.
 */
export async function GET(): Promise<Response> {
  try {
    return await relayOAuthResponse(
      await forwardToControlPlane("GET", "/internal/oauth/authorization-server-metadata")
    );
  } catch {
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: OAUTH_RESPONSE_HEADERS }
    );
  }
}
