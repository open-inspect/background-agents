/**
 * OAuth sign-in: checking an authorization request for the consent page, recording the user's
 * approval as an authorization code, and exchanging the code for a personal access token.
 *
 * Everything that could stop a token being issued is checked when the user approves, so a refusal
 * is shown on the consent page rather than reported to the client as a bare `invalid_grant`. The
 * exchange re-checks only what can change in the minutes between: the code itself, the policy
 * revision, and whether the user is still active.
 */

import type { PermissionId } from "@open-inspect/shared/rbac";
import {
  OAUTH_CONSENT_ERROR_CODES,
  type OAuthAuthorizationRequest,
  type OAuthConsentErrorCode,
  type OAuthConsentResponse,
} from "@open-inspect/shared/types/oauth";
import {
  isPersonalAccessTokenGrantable,
  isPersonalAccessTokenReadOnlyPermission,
  PERSONAL_ACCESS_TOKEN_MAX_PER_USER,
  PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH,
  personalAccessTokenEffectiveExpiry,
  personalAccessTokenMaxLifetimeDays,
  personalAccessTokenOAuthClientIds,
  personalAccessTokenPolicyAllows,
  withGrantPrerequisites,
  withGrantPrerequisitesMet,
  type PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import { generateId, hashToken } from "../auth/crypto";
import {
  refuseTokenGrant,
  TOKEN_LIMIT_REACHED,
  type TokenIssuanceRefusal,
} from "../auth/personal-access-token-issuance";
import { OAuthAuthorizationCodeStore } from "../db/oauth-authorization-codes";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore, type OwnedToken } from "../db/personal-access-tokens";
import type { SqlDatabase } from "../db/sql-database";
import { MS_PER_DAY } from "../db/utc-day";
import {
  ClientMetadataError,
  fetchClientMetadata,
  isLoopbackRedirectUri,
  isRegisteredRedirectUri,
  type ClientMetadataFetch,
} from "./client-metadata";
import { createLogger } from "../logger";
import { toolReadScopes } from "../mcp-tools/tools";
import { isS256CodeChallenge, verifyS256CodeVerifier } from "./pkce";
import { availableOAuthEndpoints, type OAuthEndpoints } from "./server";

const logger = createLogger("oauth");

/** Random bytes in an authorization code: 256 bits, hex-encoded. */
const AUTHORIZATION_CODE_BYTES = 32;

/** Who is signing in: the user, and the permissions they hold now. */
export interface ConsentingUser {
  readonly userId: string;
  readonly permissions: readonly PermissionId[];
}

/** A request whose client, redirect URI, and parameters all check out. */
interface VerifiedRequest {
  readonly endpoints: OAuthEndpoints;
  readonly policy: PersonalAccessTokenPolicySnapshot;
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeChallenge: string;
  readonly resource: string;
  /** What the user could grant this client, in registry order. */
  readonly grantable: PermissionId[];
  /** What the client asked for that the user could grant, with prerequisites. */
  readonly requested: PermissionId[];
  /** The reads the MCP tools use that the user could grant: the "Read only" choice. */
  readonly readOnly: PermissionId[];
}

type Verification =
  | { kind: "verified"; request: VerifiedRequest }
  | Exclude<OAuthConsentResponse, { kind: "consent" }>;

function pageError(code: OAuthConsentErrorCode, message: string): Verification {
  return { kind: "error", code, message };
}

/** The client's redirect URI with response parameters, always naming the issuer (RFC 9207). */
function redirectWith(
  redirectUri: string,
  issuer: string,
  state: string | undefined,
  params: Record<string, string>
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.href;
}

/** The scopes in a `scope` parameter, as distinct space-separated tokens. */
function scopeTokens(scope: string | undefined): Set<string> {
  return new Set((scope ?? "").split(" ").filter(Boolean));
}

/**
 * Check an authorization request. The client and its redirect URI are verified first, and until
 * both are nothing is sent to the redirect URI. Only a client the policy lists is fetched.
 */
async function verifyRequest(
  params: OAuthAuthorizationRequest,
  user: ConsentingUser,
  env: { WEB_APP_URL?: string; WORKER_URL?: string },
  db: SqlDatabase,
  fetcher: ClientMetadataFetch | undefined
): Promise<Verification> {
  const policy = await new PersonalAccessTokenPolicyStore(db).get();
  const endpoints = availableOAuthEndpoints(env, policy);
  if (endpoints === null) {
    return policy.mcpEnabled && !policy.enabled
      ? pageError(
          OAUTH_CONSENT_ERROR_CODES.tokensDisabled,
          "Personal access tokens are turned off for this workspace, so apps cannot sign in."
        )
      : pageError(
          OAUTH_CONSENT_ERROR_CODES.unavailable,
          "Signing in apps is turned off for this workspace."
        );
  }

  const clientId = params.client_id;
  if (!clientId || !personalAccessTokenOAuthClientIds(policy).includes(clientId)) {
    return pageError(
      OAUTH_CONSENT_ERROR_CODES.untrustedClient,
      "This app is not one the workspace allows to sign in. An administrator can add it in the API policy."
    );
  }
  let metadata;
  try {
    metadata = await fetchClientMetadata(clientId, fetcher);
  } catch (cause) {
    return pageError(
      OAUTH_CONSENT_ERROR_CODES.clientMetadataInvalid,
      cause instanceof ClientMetadataError ? cause.message : "The app could not be verified"
    );
  }
  const redirectUri = params.redirect_uri;
  if (!redirectUri || !isRegisteredRedirectUri(metadata, redirectUri)) {
    return pageError(
      OAUTH_CONSENT_ERROR_CODES.invalidRedirectUri,
      "The app asked to return somewhere it has not registered."
    );
  }

  // The client and redirect URI are verified: protocol errors from here go back to the client.
  const back = (error: string, description: string): Verification => ({
    kind: "redirect",
    url: redirectWith(redirectUri, endpoints.issuer, params.state, {
      error,
      error_description: description,
    }),
  });
  if (params.response_type !== "code") {
    return back("unsupported_response_type", "Only the authorization code flow is supported");
  }
  if (params.code_challenge_method !== "S256" || !params.code_challenge) {
    return back("invalid_request", "PKCE with code_challenge_method S256 is required");
  }
  if (!isS256CodeChallenge(params.code_challenge)) {
    return back("invalid_request", "code_challenge is not an S256 challenge");
  }
  // Tokens are issued for the hosted MCP server; a client that names no resource means it.
  const resource = params.resource ?? endpoints.resource;
  if (resource !== endpoints.resource) {
    return back("invalid_target", `Tokens are issued only for ${endpoints.resource}`);
  }

  const grantable = withGrantPrerequisitesMet(
    user.permissions
      .filter(isPersonalAccessTokenGrantable)
      .filter((permission) => personalAccessTokenPolicyAllows(policy, permission))
  );
  if (grantable.length === 0) {
    return pageError(
      OAUTH_CONSENT_ERROR_CODES.nothingGrantable,
      "Your role holds no permission an app can be granted."
    );
  }
  // Scopes the user cannot grant are left out rather than refused: the token gets less, and a
  // tool that needs more tells the model so.
  const asked = scopeTokens(params.scope);
  // `grantable` holds every prerequisite of what it holds, so adding them keeps within it.
  const toolReads = new Set(toolReadScopes());
  const readOnly = grantable.filter((permission) => toolReads.has(permission));
  let requested = withGrantPrerequisites(grantable.filter((permission) => asked.has(permission)));
  if (requested.length === 0) requested = readOnly;

  return {
    kind: "verified",
    request: {
      endpoints,
      policy,
      clientId,
      clientName: metadata.clientName,
      redirectUri,
      state: params.state,
      codeChallenge: params.code_challenge,
      resource,
      grantable,
      requested,
      readOnly,
    },
  };
}

/** The host a client is served from: the identity consent names, not the client's own claim. */
function clientHost(clientId: string): string {
  return new URL(clientId).host;
}

/**
 * The name a token issued to a client is listed under: the client's own name with its host, which
 * tells apart two clients served from one host, or the host alone. Within the name length cap.
 */
function tokenName(clientId: string, clientName: string | null): string {
  const host = clientHost(clientId);
  const full = clientName === null ? `${host} (OAuth)` : `${clientName} (${host})`;
  return full.slice(0, PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH);
}

/**
 * How long after `/mcp` asks a client to step up the sign-in that follows replaces the token it
 * asked about (when only one was asked; see `ClientTokens.stepUp`). Long enough for the user to read the consent page; short enough that a later,
 * unrelated sign-in from the same client replaces nothing.
 */
export const STEP_UP_REPLACEMENT_WINDOW_MS = 15 * 60 * 1000;

/** The user's tokens as a new sign-in from a client sees them, read in one snapshot. */
interface ClientTokens {
  /**
   * The token a step-up from this client replaces: the one live token of the client's that
   * `/mcp` asked to step up within the window. OAuth carries nothing from the challenge to the
   * sign-in it starts, so when two or more were asked (two devices refused at once), which one is
   * signing in is unknown, and none is replaced.
   */
  readonly stepUp: OwnedToken | null;
  /** The client's tokens past their effective expiry: pruned when the new token is issued. */
  readonly expiredIds: string[];
  /** Every token the user holds, in the same snapshot. */
  readonly held: number;
}

async function clientTokens(
  db: SqlDatabase,
  userId: string,
  clientId: string,
  policy: PersonalAccessTokenPolicySnapshot,
  now: number
): Promise<ClientTokens> {
  const owned = await new PersonalAccessTokenStore(db).listOwned(userId);
  const fromClient = owned.filter((token) => token.oauthClientId === clientId);
  const live = fromClient.filter(
    (token) => personalAccessTokenEffectiveExpiry(token, policy) > now
  );
  const asked = live.filter(
    (token) =>
      token.stepUpRequestedAt !== null &&
      now - token.stepUpRequestedAt <= STEP_UP_REPLACEMENT_WINDOW_MS
  );
  return {
    stepUp: asked.length === 1 ? asked[0] : null,
    expiredIds: fromClient.filter((token) => !live.includes(token)).map((token) => token.id),
    held: owned.length,
  };
}

/** Whether a grant writes: only then is it a step-up that replaces the token that asked for it. */
function writes(permissions: readonly PermissionId[]): boolean {
  return permissions.some((permission) => !isPersonalAccessTokenReadOnlyPermission(permission));
}

/** What the consent page shows for an authorization request. */
export async function describeAuthorizationRequest(
  params: OAuthAuthorizationRequest,
  user: ConsentingUser,
  env: { WEB_APP_URL?: string; WORKER_URL?: string },
  db: SqlDatabase,
  fetcher?: ClientMetadataFetch
): Promise<OAuthConsentResponse> {
  const verification = await verifyRequest(params, user, env, db, fetcher);
  if (verification.kind !== "verified") return verification;
  const { request } = verification;
  const { stepUp: replaces } = await clientTokens(
    db,
    user.userId,
    request.clientId,
    request.policy,
    Date.now()
  );
  return {
    kind: "consent",
    client: {
      id: request.clientId,
      host: clientHost(request.clientId),
      name: request.clientName,
    },
    redirect: {
      host: new URL(request.redirectUri).host,
      loopback: isLoopbackRedirectUri(request.redirectUri),
    },
    requested: request.requested,
    grantable: request.grantable,
    readOnly: request.readOnly,
    maxLifetimeDays: personalAccessTokenMaxLifetimeDays(request.policy),
    replaces:
      replaces === null
        ? null
        : {
            id: replaces.id,
            name: replaces.name,
            displayPrefix: replaces.displayPrefix,
            createdAt: replaces.createdAt,
            lastUsedAt: replaces.lastUsedAt,
          },
    denyUrl: redirectWith(request.redirectUri, request.endpoints.issuer, request.state, {
      error: "access_denied",
    }),
  };
}

export type ApprovalOutcome =
  { kind: "approved"; redirectUrl: string } | { kind: "refused"; refusal: TokenIssuanceRefusal };

function consentRefusal(verification: Exclude<Verification, { kind: "verified" }>) {
  return {
    kind: "refused" as const,
    refusal: {
      status: 400 as const,
      body:
        verification.kind === "error"
          ? { error: verification.message, code: verification.code }
          : { error: "The app's request is not valid", code: "oauth_request_invalid" },
    },
  };
}

/**
 * Record the user's approval of a request, with the grant and lifetime they chose, as an
 * authorization code, and return where to send the browser with it. The request is verified
 * again, and every rule a token is issued under is checked now, so the exchange can only fail for
 * what changes after this.
 */
export async function approveAuthorizationRequest(
  input: {
    params: OAuthAuthorizationRequest;
    permissions: readonly PermissionId[];
    expiresInDays: number;
    /** The token the consent page showed this approval replacing, or null. */
    replacesTokenId: string | null;
  },
  user: ConsentingUser,
  env: { WEB_APP_URL?: string; WORKER_URL?: string },
  db: SqlDatabase,
  fetcher?: ClientMetadataFetch
): Promise<ApprovalOutcome> {
  const verification = await verifyRequest(input.params, user, env, db, fetcher);
  if (verification.kind !== "verified") return consentRefusal(verification);
  const { request } = verification;

  const refusal = refuseTokenGrant(
    request.policy,
    new Set(user.permissions),
    input.permissions,
    input.expiresInDays
  );
  if (refusal) return { kind: "refused", refusal };

  const now = Date.now();
  const {
    stepUp,
    expiredIds,
    held: holding,
  } = await clientTokens(db, user.userId, request.clientId, request.policy, now);
  // A grant of reads alone is not a step-up, even on the sign-in a challenge started.
  const replaces = writes(input.permissions) ? (stepUp?.id ?? null) : null;
  if (input.replacesTokenId !== replaces) {
    return {
      kind: "refused",
      refusal: {
        status: 409,
        body: {
          error:
            "The connection this would replace has changed since the page loaded. Reload the page and try again.",
          code: OAUTH_CONSENT_ERROR_CODES.replacementChanged,
        },
      },
    };
  }
  // What issue revokes does not count, and both come from one snapshot of the user's tokens.
  const held = holding - (replaces === null ? 0 : 1) - expiredIds.length;
  if (held >= PERSONAL_ACCESS_TOKEN_MAX_PER_USER) {
    return { kind: "refused", refusal: TOKEN_LIMIT_REACHED };
  }

  const code = generateId(AUTHORIZATION_CODE_BYTES);
  await new OAuthAuthorizationCodeStore(db).create(
    await hashToken(code),
    {
      userId: user.userId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      permissions: input.permissions,
      expiresInDays: input.expiresInDays,
      tokenName: tokenName(request.clientId, request.clientName),
      replacesTokenId: replaces,
      policyRevision: request.policy.revision,
    },
    now
  );
  return {
    kind: "approved",
    redirectUrl: redirectWith(request.redirectUri, request.endpoints.issuer, request.state, {
      code,
    }),
  };
}

/** A token request's parameters, as the web app forwards them from the client's form. */
export interface TokenRequest {
  readonly grant_type?: string;
  readonly code?: string;
  readonly redirect_uri?: string;
  readonly client_id?: string;
  readonly code_verifier?: string;
  readonly resource?: string;
}

/** An RFC 6749 §5 token response: the token, or an error with the status to send it with. */
export type TokenResponse =
  | {
      kind: "token";
      body: { access_token: string; token_type: "Bearer"; expires_in: number; scope: string };
    }
  | { kind: "error"; status: 400; body: { error: string; error_description: string } };

function tokenError(error: string, description: string): TokenResponse {
  return { kind: "error", status: 400, body: { error, error_description: description } };
}

const INVALID_CODE = "The authorization code is invalid, expired, or already used";

/**
 * Exchange an authorization code for a token. The code is claimed before anything else is checked,
 * so it is spent whatever the outcome. A code presented a second time revokes the token its first
 * use issued: one of the two presenters is not the client the user approved.
 */
export async function exchangeAuthorizationCode(
  params: TokenRequest,
  env: { WEB_APP_URL?: string; WORKER_URL?: string },
  db: SqlDatabase,
  requestId: string
): Promise<TokenResponse> {
  if (params.grant_type !== "authorization_code") {
    return tokenError("unsupported_grant_type", "Only authorization_code is supported");
  }
  if (!params.code || !params.code_verifier || !params.client_id || !params.redirect_uri) {
    return tokenError(
      "invalid_request",
      "code, code_verifier, client_id, and redirect_uri are required"
    );
  }

  const now = Date.now();
  const codeHash = await hashToken(params.code);
  const claim = await new OAuthAuthorizationCodeStore(db).claim(codeHash, now);
  if (claim.kind === "replayed") {
    // One of the two presenters is not the client the user approved: whoever it is, the code's
    // token is no longer trusted.
    logger.warn("Authorization code presented again", {
      event: "oauth.code_replayed",
      user_id: claim.userId,
      revoked_token_id: claim.issuedTokenId,
      request_id: requestId,
    });
    if (claim.issuedTokenId !== null) {
      await new PersonalAccessTokenStore(db).revoke({
        userId: claim.userId,
        tokenId: claim.issuedTokenId,
        actorUserId: claim.userId,
        now,
        requestId,
        reason: "oauth_code_replayed",
      });
    }
    return tokenError("invalid_grant", INVALID_CODE);
  }
  if (claim.kind === "unknown") return tokenError("invalid_grant", INVALID_CODE);

  const { code } = claim;
  if (code.expiresAt <= now) return tokenError("invalid_grant", INVALID_CODE);
  if (code.clientId !== params.client_id || code.redirectUri !== params.redirect_uri) {
    return tokenError("invalid_grant", "The code was issued to another client or redirect URI");
  }
  if (params.resource !== undefined && params.resource !== code.resource) {
    return tokenError("invalid_target", "The code was issued for another resource");
  }
  if (!(await verifyS256CodeVerifier(params.code_verifier, code.codeChallenge))) {
    return tokenError("invalid_grant", "The code verifier does not match the code challenge");
  }

  const policy = await new PersonalAccessTokenPolicyStore(db).get();
  if (availableOAuthEndpoints(env, policy) === null) {
    return tokenError("invalid_grant", "Signing in apps is turned off for this workspace");
  }
  const { expiredIds } = await clientTokens(db, code.userId, code.clientId, policy, now);
  const result = await new PersonalAccessTokenStore(db).issue({
    userId: code.userId,
    name: code.tokenName,
    permissions: code.permissions,
    expiresAt: now + code.expiresInDays * MS_PER_DAY,
    now,
    requestId,
    policyRevision: code.policyRevision,
    oauth: {
      clientId: code.clientId,
      codeHash,
      replacesTokenId: code.replacesTokenId,
      expiredTokenIds: expiredIds,
    },
  });
  switch (result.kind) {
    case "issued":
      return {
        kind: "token",
        body: {
          access_token: result.token.token,
          token_type: "Bearer",
          expires_in: Math.floor((result.token.expiresAt - now) / 1000),
          scope: result.token.permissions.join(" "),
        },
      };
    case "policy_changed":
      return tokenError("invalid_grant", "The workspace's API policy changed; sign in again");
    case "limit_reached":
      return tokenError("invalid_grant", "The user holds the most tokens allowed");
    case "user_inactive":
      return tokenError("invalid_grant", "The user's workspace access is disabled");
    case "code_unavailable":
      return tokenError("invalid_grant", INVALID_CODE);
  }
}
