/**
 * The client address the hosting platform vouches for, or null where it vouches for none. Each
 * platform sets its own header and overwrites a client's copy of it; a header from another
 * platform is the client's own and could say anything, so only the platform's is read.
 */
export function trustedClientIp(request: Request): string | null {
  if (process.env.VERCEL === "1") {
    return request.headers.get("X-Vercel-Forwarded-For");
  }
  // Cloudflare Workers mark their requests with `cf`.
  return "cf" in request ? request.headers.get("CF-Connecting-IP") : null;
}
