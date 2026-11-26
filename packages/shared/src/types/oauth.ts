/**
 * OAuth sign-in for MCP clients: the contract between the web app, which serves the consent page
 * and the token endpoint, and the control plane, which checks every request and issues the token.
 *
 * The access token an MCP client receives is an ordinary personal access token, recorded as issued
 * to that client. Scopes are the permission ids a token can be granted. There are no refresh
 * tokens: a token lives for the lifetime chosen at consent, capped by the API policy.
 */

import { z } from "zod";
import { permissionIdSchema } from "../rbac";

/** Longest value any OAuth request parameter may have, at either endpoint. */
export const OAUTH_PARAMETER_MAX_LENGTH = 4096;

const parameter = z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional();

/**
 * An authorization request's parameters as the client sent them in the consent page's query. Each
 * is checked by the control plane; none is trusted here beyond its length.
 */
export const oauthAuthorizationRequestSchema = z.strictObject({
  response_type: parameter,
  client_id: parameter,
  redirect_uri: parameter,
  state: parameter,
  scope: parameter,
  code_challenge: parameter,
  code_challenge_method: parameter,
  resource: parameter,
});
export type OAuthAuthorizationRequest = z.infer<typeof oauthAuthorizationRequestSchema>;

/** The parameter names an authorization request may carry, in the order a link writes them. */
export const OAUTH_AUTHORIZATION_REQUEST_PARAMETERS = Object.keys(
  oauthAuthorizationRequestSchema.shape
) as (keyof OAuthAuthorizationRequest)[];

/** Stable codes for an authorization request the consent page cannot proceed with. */
export const OAUTH_CONSENT_ERROR_CODES = {
  /** MCP clients, and so OAuth sign-in, are turned off, or the deployment lacks its URLs. */
  unavailable: "oauth_unavailable",
  /** Personal access tokens are turned off for the workspace. */
  tokensDisabled: "personal_access_tokens_disabled",
  /** The client is not one the API policy lists, or names no client at all. */
  untrustedClient: "oauth_client_untrusted",
  /** The client's metadata document could not be fetched or is not valid. */
  clientMetadataInvalid: "oauth_client_metadata_invalid",
  /** The redirect URI is missing or not one the client's metadata document lists. */
  invalidRedirectUri: "oauth_redirect_uri_invalid",
  /** The user holds no permission a token may be granted. */
  nothingGrantable: "oauth_nothing_grantable",
  /** The token an approval would replace is not the one the page showed; reload and retry. */
  replacementChanged: "oauth_replacement_changed",
} as const;
export type OAuthConsentErrorCode =
  (typeof OAUTH_CONSENT_ERROR_CODES)[keyof typeof OAUTH_CONSENT_ERROR_CODES];

/** An earlier token from the same client that approving would replace. */
export const oauthReplacedTokenSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** The token's visible first characters, which tell apart two tokens of one app. */
  displayPrefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});

/**
 * What the consent page shows, or why it cannot. `redirect` sends the user back to the client with
 * an error the client must see (a malformed request from a client and redirect URI already
 * verified); `error` is shown on the page and never redirected, because the client or its redirect
 * URI could not be verified, or the problem is the workspace's, not the client's.
 */
export const oauthConsentResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("consent"),
    /**
     * The client's id and the host serving it, the identity consent names, and the name its
     * document gives it. The name is the document's own claim, shown only beside the host; it is
     * trusted no further than the administrator who listed the client.
     */
    client: z.strictObject({ id: z.string(), host: z.string(), name: z.string().nullable() }),
    /** Where the code is sent; a loopback host means an app on this device. */
    redirect: z.strictObject({ host: z.string(), loopback: z.boolean() }),
    /** The scopes asked for that the user could grant, in registry order. */
    requested: z.array(permissionIdSchema),
    /** Every permission the user could grant this client, in registry order. */
    grantable: z.array(permissionIdSchema),
    /** The "Read only" choice: the reads the MCP tools use that the user could grant. */
    readOnly: z.array(permissionIdSchema),
    maxLifetimeDays: z.number().int(),
    /**
     * The token `/mcp` just asked this client to step up from, which approving with any write
     * permission replaces: set only when exactly one of the user's live tokens from this client was
     * asked within the window. OAuth carries nothing from the challenge to this sign-in, so with
     * two or more asked it is unknown which is signing in, and none is replaced. Approving with
     * reads alone replaces nothing.
     */
    replaces: oauthReplacedTokenSchema.nullable(),
    /** Where declining sends the user: the client's redirect URI with `access_denied`. */
    denyUrl: z.string(),
  }),
  z.strictObject({ kind: z.literal("redirect"), url: z.string() }),
  z.strictObject({ kind: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type OAuthConsentResponse = z.infer<typeof oauthConsentResponseSchema>;

/**
 * The user's approval: the request it answers, the grant and lifetime they chose, and the token it
 * replaces as the page showed it (null for none). Approval is refused if that no longer matches.
 */
export const oauthApprovalRequestSchema = z.strictObject({
  request: oauthAuthorizationRequestSchema,
  permissions: z.array(permissionIdSchema).min(1),
  expiresInDays: z.number().int().min(1),
  replacesTokenId: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).nullable(),
});
export type OAuthApprovalRequest = z.infer<typeof oauthApprovalRequestSchema>;

/** Where the browser goes once approval is recorded: the client's redirect URI with the code. */
export const oauthApprovalResponseSchema = z.strictObject({ redirectUrl: z.string() });
export type OAuthApprovalResponse = z.infer<typeof oauthApprovalResponseSchema>;
