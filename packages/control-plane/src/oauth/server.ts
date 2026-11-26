/**
 * The deployment as an OAuth authorization server for its own hosted MCP server.
 *
 * The web app's origin is the issuer: it serves the authorization server metadata, the consent
 * page, and the token endpoint, which forwards here. The control plane is the protected resource:
 * the hosted MCP server at `<control plane>/mcp`, which publishes its protected resource metadata
 * and points clients at the issuer.
 *
 * Sign-in needs both public URLs, so without either it is unavailable, as it is while the API
 * policy has personal access tokens or MCP clients turned off.
 */

import {
  PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS,
  personalAccessTokenPolicyAllows,
  type PersonalAccessTokenPolicy,
} from "@open-inspect/shared/types/personal-access-tokens";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { parsePublicWebOrigin } from "../auth/user/runtime";
import { toolReadScopes } from "../mcp-tools/tools";
import type { Env } from "../types";

/** Where the protected resource metadata for `/mcp` is served, relative to the control plane. */
export const MCP_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/** The consent page and token endpoint, relative to the issuer (the web app). */
const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
const OAUTH_TOKEN_PATH = "/oauth/token";

export interface OAuthEndpoints {
  /** The web app's origin. */
  readonly issuer: string;
  /** The hosted MCP server's URL, which tokens are requested for. */
  readonly resource: string;
  readonly resourceMetadataUrl: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The control plane's origin, which the resource identifier is built on: HTTPS, as RFC 9728
 * requires of a resource identifier, or plain HTTP on a loopback host for local development.
 */
function controlPlaneOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const local = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
    return secure || local ? url.origin : null;
  } catch {
    return null;
  }
}

function webOrigin(value: string | undefined): string | null {
  try {
    return parsePublicWebOrigin(value);
  } catch {
    return null;
  }
}

/** The deployment's OAuth URLs, or null when either public URL is missing or malformed. */
export function oauthEndpoints(
  env: Pick<Env, "WEB_APP_URL" | "WORKER_URL">
): OAuthEndpoints | null {
  const issuer = webOrigin(env.WEB_APP_URL);
  const controlPlane = controlPlaneOrigin(env.WORKER_URL);
  if (issuer === null || controlPlane === null) return null;
  return {
    issuer,
    resource: `${controlPlane}/mcp`,
    resourceMetadataUrl: `${controlPlane}${MCP_RESOURCE_METADATA_PATH}`,
  };
}

/** The policy fields sign-in depends on. */
export type OAuthPolicy = PersonalAccessTokenPolicy & { mcpEnabled: boolean };

/** The deployment's OAuth URLs while the policy allows sign-in, otherwise null. */
export function availableOAuthEndpoints(
  env: Pick<Env, "WEB_APP_URL" | "WORKER_URL">,
  policy: OAuthPolicy
): OAuthEndpoints | null {
  if (!policy.enabled || !policy.mcpEnabled) return null;
  return oauthEndpoints(env);
}

/** Every scope a token may be granted under the policy: grantable permissions it allows. */
function supportedScopes(policy: PersonalAccessTokenPolicy): PermissionId[] {
  return PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS.filter((permission) =>
    personalAccessTokenPolicyAllows(policy, permission)
  );
}

/**
 * The scopes a client is first asked to request: the reads the MCP tools use, within the policy.
 * Other reads, and any write, are the user's to add at consent; a tool that needs a write asks for
 * it by step-up.
 */
export function readOnlyScopes(policy: PersonalAccessTokenPolicy): PermissionId[] {
  const toolReads = new Set(toolReadScopes());
  return supportedScopes(policy).filter((permission) => toolReads.has(permission));
}

/** RFC 8414 authorization server metadata, as the web app serves it. */
export function authorizationServerMetadata(endpoints: OAuthEndpoints, policy: OAuthPolicy) {
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: `${endpoints.issuer}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${endpoints.issuer}${OAUTH_TOKEN_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    // No refresh tokens: a token lives for the lifetime chosen at consent, capped by the policy.
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: supportedScopes(policy),
  };
}

/** RFC 9728 protected resource metadata for the hosted MCP server. */
export function protectedResourceMetadata(endpoints: OAuthEndpoints, policy: OAuthPolicy) {
  return {
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: readOnlyScopes(policy),
  };
}

/** A `WWW-Authenticate` parameter value, quoted. Scope and URL values carry no quotes. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

/**
 * The Bearer challenge for `/mcp`. With sign-in available it points the client at the resource
 * metadata and names the scopes to ask for, which is what starts an MCP client's sign-in.
 */
export function bearerChallenge(
  endpoints: OAuthEndpoints | null,
  params: { error?: "invalid_token" | "insufficient_scope"; scope?: readonly string[] } = {}
): string {
  const parts = ['realm="open-inspect"'];
  if (params.error) parts.push(`error=${quoted(params.error)}`);
  if (endpoints) {
    parts.push(`resource_metadata=${quoted(endpoints.resourceMetadataUrl)}`);
    if (params.scope && params.scope.length > 0) {
      parts.push(`scope=${quoted(params.scope.join(" "))}`);
    }
  }
  return `Bearer ${parts.join(", ")}`;
}
