import "server-only";

/**
 * The web app's side of OAuth sign-in for MCP clients. This origin is the issuer: it publishes the
 * authorization server metadata and serves the token endpoint, both by forwarding to the control
 * plane, which checks everything and issues the token. Nothing here decides anything about a
 * request beyond its shape.
 */

import { dispatchWebServiceRequest } from "./control-plane-service";
import { getCorrelationLogFields } from "./request-correlation";
import { getRequestCorrelation } from "./request-context";

/** Response headers for every OAuth endpoint answer: never cached, readable cross-origin. */
export const OAUTH_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Access-Control-Allow-Origin": "*",
} as const;

/** Forward a request to one of the control plane's web-app-only OAuth routes. */
export async function forwardToControlPlane(
  method: "GET" | "POST",
  path: "/internal/oauth/authorization-server-metadata" | "/internal/oauth/token",
  body?: string
): Promise<Response> {
  const correlation = await getRequestCorrelation();
  return dispatchWebServiceRequest({
    method,
    path,
    ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
    traceId: correlation.traceId,
    correlationFields: getCorrelationLogFields(correlation),
    transportOptions: { redirect: "manual", cache: "no-store" },
  });
}

/** The control plane's JSON answer, relayed with its status and the OAuth response headers. */
export async function relayOAuthResponse(response: Response): Promise<Response> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return Response.json(
      {
        error: "server_error",
        // The code may have been spent; presenting it again would revoke what it issued.
        error_description:
          "Unexpected response from the control plane. If no token was received, start authorization again; do not retry this code.",
      },
      { status: 502, headers: OAUTH_RESPONSE_HEADERS }
    );
  }
  return Response.json(body, { status: response.status, headers: OAUTH_RESPONSE_HEADERS });
}

/**
 * A fixed-window count of requests per key, kept in this instance's memory: a brake on one client
 * hammering the token endpoint, not a guarantee across instances. Codes are 256-bit and single-use,
 * so the limit guards the control plane's capacity rather than the codes.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Most keys tracked at once; the oldest window is dropped beyond it. */
    private readonly maxKeys = 10_000
  ) {}

  /** Count a request for `key`; false once the key has used its window's allowance. */
  take(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}
