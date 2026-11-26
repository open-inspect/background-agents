import { describe, expect, it } from "vitest";
import {
  OAUTH_AUTHORIZATION_REQUEST_PARAMETERS,
  oauthApprovalRequestSchema,
  oauthAuthorizationRequestSchema,
  oauthConsentResponseSchema,
} from "./oauth";

describe("OAuth sign-in contract", () => {
  it("names the authorization request parameters the consent page forwards", () => {
    expect(OAUTH_AUTHORIZATION_REQUEST_PARAMETERS).toEqual([
      "response_type",
      "client_id",
      "redirect_uri",
      "state",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "resource",
    ]);
  });

  it("refuses an authorization request with an unknown or over-long parameter", () => {
    expect(oauthAuthorizationRequestSchema.safeParse({ prompt: "consent" }).success).toBe(false);
    expect(oauthAuthorizationRequestSchema.safeParse({ state: "x".repeat(4097) }).success).toBe(
      false
    );
  });

  it("requires an approval to grant something for at least a day", () => {
    const valid = {
      request: {},
      permissions: ["sessions.read"],
      expiresInDays: 1,
      replacesTokenId: null,
    };
    expect(oauthApprovalRequestSchema.safeParse(valid).success).toBe(true);
    expect(oauthApprovalRequestSchema.safeParse({ ...valid, permissions: [] }).success).toBe(false);
    expect(oauthApprovalRequestSchema.safeParse({ ...valid, expiresInDays: 0 }).success).toBe(
      false
    );
    // The replacement the page showed is always stated, null when there is none.
    const { replacesTokenId: _omitted, ...withoutReplacement } = valid;
    expect(oauthApprovalRequestSchema.safeParse(withoutReplacement).success).toBe(false);
  });

  it("parses each consent outcome", () => {
    for (const outcome of [
      { kind: "redirect", url: "https://client.example/cb?error=invalid_request" },
      { kind: "error", code: "oauth_client_untrusted", message: "Not allowed" },
    ]) {
      expect(oauthConsentResponseSchema.parse(outcome)).toEqual(outcome);
    }
  });
});
