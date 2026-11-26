/**
 * Where to send the browser after signing in: a path on this app, never another origin. A value
 * that is not a plain same-origin path (a protocol-relative `//host`, a backslash a browser reads
 * as a slash, an absolute URL, a control character) is refused rather than repaired.
 */

const PARSER_ORIGIN = "https://return-to.invalid";

/** Longest return-to accepted; an OAuth authorization request fits well within it. */
export const MAX_RETURN_TO_LENGTH = 8192;

/** The path to return to after signing in, or null when `value` is not a safe same-origin path. */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_RETURN_TO_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, PARSER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PARSER_ORIGIN) return null;
  // Checked on the result, not only the input: parsing removes dot segments, so `/.//host` and
  // `/%2e//host` become `//host`, which a browser reads as another origin.
  const path = `${url.pathname}${url.search}`;
  return /^\/(?![/\\])/.test(path) ? path : null;
}

/** The sign-in page, returning to `path` afterwards. */
export function signInPath(path: string): string {
  return `/login?${new URLSearchParams({ returnTo: path })}`;
}
