/**
 * PKCE (RFC 7636), S256 only: the token request must present the verifier whose SHA-256 the
 * authorization request committed to, so an intercepted code is useless to anyone else.
 */

import { timingSafeEqual } from "@open-inspect/shared/auth";

/** A verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** An S256 challenge: the base64url SHA-256 of a verifier, without padding. */
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

export function isS256CodeChallenge(value: string): boolean {
  return S256_CHALLENGE_PATTERN.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The S256 challenge for a verifier. */
export async function s256CodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Whether `verifier` is well formed and answers `challenge`. */
export async function verifyS256CodeVerifier(
  verifier: string,
  challenge: string
): Promise<boolean> {
  if (!CODE_VERIFIER_PATTERN.test(verifier)) return false;
  return timingSafeEqual(await s256CodeChallenge(verifier), challenge);
}
