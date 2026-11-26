import { readBodyCapped } from "@open-inspect/shared/http-body";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import {
  FixedWindowRateLimiter,
  forwardToControlPlane,
  OAUTH_RESPONSE_HEADERS,
  relayOAuthResponse,
} from "@/lib/oauth-server";

export const dynamic = "force-dynamic";

/** The token request fields forwarded; any other is dropped. */
const TOKEN_REQUEST_FIELDS = [
  "grant_type",
  "code",
  "redirect_uri",
  "client_id",
  "code_verifier",
  "resource",
] as const;

/** A token request is a handful of short fields. */
const MAX_TOKEN_REQUEST_BYTES = 16 * 1024;

/** The window token requests are counted over, per client address. */
const TOKEN_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Token requests one address may make per window. A client makes one per sign-in. */
export const TOKEN_REQUESTS_PER_WINDOW = 30;

const limiter = new FixedWindowRateLimiter(
  TOKEN_REQUESTS_PER_WINDOW,
  TOKEN_RATE_LIMIT_WINDOW_SECONDS * 1000
);

/** What a client is told when the exchange's outcome is unknown. */
const RESTART_AUTHORIZATION =
  "The token request did not complete. If no token was received, start authorization again; do not retry this code.";

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: OAUTH_RESPONSE_HEADERS }
  );
}

/**
 * The OAuth token endpoint (RFC 6749 §3.2). Takes the form-encoded request an MCP client sends and
 * forwards its fields to the control plane, which exchanges the authorization code for a token.
 */
export async function POST(request: Request): Promise<Response> {
  // Counted per address the platform vouches for. Where it vouches for none (a self-hosted server
  // behind a proxy of its own), any header could be forged, so nothing is counted here.
  const address = trustedClientIp(request);
  if (address !== null && !limiter.take(address)) {
    // RFC 6749 §5.2 has no code for throttling. 429 and Retry-After carry the meaning; the body
    // keeps a §5.2 shape, and invalid_request, unlike invalid_grant, does not tell the client its
    // code is bad, which would send it to start sign-in over.
    const response = oauthError(
      "invalid_request",
      `Too many token requests; retry after ${TOKEN_RATE_LIMIT_WINDOW_SECONDS} seconds`,
      429
    );
    response.headers.set("Retry-After", String(TOKEN_RATE_LIMIT_WINDOW_SECONDS));
    return response;
  }
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return oauthError("invalid_request", "The request must be form-encoded");
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(request.body, MAX_TOKEN_REQUEST_BYTES);
  } catch {
    // A body that broke off is never forwarded in part.
    return oauthError("invalid_request", "The request could not be read");
  }
  if (bytes === null) return oauthError("invalid_request", "The request is too large");
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  const fields: Record<string, string> = {};
  for (const name of TOKEN_REQUEST_FIELDS) {
    const values = form.getAll(name);
    if (values.length > 1) return oauthError("invalid_request", `${name} is repeated`);
    if (values.length === 1) fields[name] = values[0];
  }
  try {
    return await relayOAuthResponse(
      await forwardToControlPlane("POST", "/internal/oauth/token", JSON.stringify(fields))
    );
  } catch {
    // The control plane may have spent the code before the answer was lost, and presenting a
    // spent code again revokes the token it issued: the client must start over, not retry.
    return oauthError("temporarily_unavailable", RESTART_AUTHORIZATION, 503);
  }
}

/** Preflight for a browser-based client. */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...OAUTH_RESPONSE_HEADERS,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
