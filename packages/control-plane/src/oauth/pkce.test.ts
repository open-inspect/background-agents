import { describe, expect, it } from "vitest";
import { isS256CodeChallenge, s256CodeChallenge, verifyS256CodeVerifier } from "./pkce";

// RFC 7636 Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE S256", () => {
  it("computes the RFC 7636 example challenge", async () => {
    await expect(s256CodeChallenge(VERIFIER)).resolves.toBe(CHALLENGE);
    expect(isS256CodeChallenge(CHALLENGE)).toBe(true);
  });

  it("accepts the verifier that answers the challenge, and no other", async () => {
    await expect(verifyS256CodeVerifier(VERIFIER, CHALLENGE)).resolves.toBe(true);
    await expect(verifyS256CodeVerifier(`${VERIFIER.slice(0, -1)}l`, CHALLENGE)).resolves.toBe(
      false
    );
  });

  it("refuses a malformed verifier even when it answers its own challenge", async () => {
    for (const verifier of ["short", "x".repeat(129), `${VERIFIER.slice(0, 42)} `]) {
      await expect(
        verifyS256CodeVerifier(verifier, await s256CodeChallenge(verifier))
      ).resolves.toBe(false);
    }
  });

  it("refuses a malformed verifier even before comparing", async () => {
    for (const verifier of ["short", "x".repeat(129), `${VERIFIER.slice(0, 42)} `]) {
      await expect(verifyS256CodeVerifier(verifier, CHALLENGE)).resolves.toBe(false);
    }
  });

  it("recognizes only a 43-character base64url challenge", () => {
    for (const challenge of ["plain-verifier", `${CHALLENGE}=`, CHALLENGE.replace("-", "+")]) {
      expect(isS256CodeChallenge(challenge)).toBe(false);
    }
  });
});
