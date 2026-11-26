/**
 * OAuth sign-in for MCP clients.
 *
 * The web app's origin is the issuer, and the browser-facing endpoints live there: the consent
 * page reaches the two `user` routes below through the web app's signed session, and the web app
 * serves the authorization server metadata and the token endpoint by forwarding to the two
 * `web-service` routes. The protected resource metadata belongs to the hosted MCP server, so it is
 * served here, publicly.
 *
 * None of these routes accepts a personal access token: a token can never take part in issuing
 * another, and the token endpoint's only credential is the code and its PKCE verifier.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  OAUTH_PARAMETER_MAX_LENGTH,
  oauthApprovalRequestSchema,
  oauthAuthorizationRequestSchema,
} from "@open-inspect/shared/types/oauth";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import {
  approveAuthorizationRequest,
  describeAuthorizationRequest,
  exchangeAuthorizationCode,
} from "../oauth/authorization";
import {
  authorizationServerMetadata,
  availableOAuthEndpoints,
  MCP_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
} from "../oauth/server";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  ACTIVE_SELF,
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type RequestContext,
  type UserRouteContext,
} from "./shared";

/** A token request as the web app forwards it: the client's form fields, as strings. */
const tokenRequestSchema = z.object({
  grant_type: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
  code: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
  redirect_uri: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
  client_id: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
  code_verifier: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
  resource: z.string().max(OAUTH_PARAMETER_MAX_LENGTH).optional(),
});

/**
 * Sign-in metadata is absent while sign-in is unavailable. The 404 says why, so it is told apart
 * from a path that was never served.
 */
const OAUTH_UNAVAILABLE = "OAuth sign-in is not available";
async function handleProtectedResourceMetadata(
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const policy = await new PersonalAccessTokenPolicyStore(ctx.db).get();
  const endpoints = availableOAuthEndpoints(env, policy);
  if (endpoints === null) return error(OAUTH_UNAVAILABLE, 404);
  return json(protectedResourceMetadata(endpoints, policy));
}

async function handleAuthorizationServerMetadata(
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const policy = await new PersonalAccessTokenPolicyStore(ctx.db).get();
  const endpoints = availableOAuthEndpoints(env, policy);
  if (endpoints === null) return error(OAUTH_UNAVAILABLE, 404);
  return json(authorizationServerMetadata(endpoints, policy));
}

/** The user who is signing in, as ACTIVE_SELF admission loaded them. */
function consentingUser(ctx: UserRouteContext) {
  return { userId: ctx.principal.userId, permissions: ctx.authorization?.permissions ?? [] };
}

async function handleCheck(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, oauthAuthorizationRequestSchema);
  if (parsed instanceof Response) return parsed;
  return json(await describeAuthorizationRequest(parsed, consentingUser(ctx), env, ctx.db));
}

async function handleApprove(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, oauthApprovalRequestSchema);
  if (parsed instanceof Response) return parsed;
  const outcome = await approveAuthorizationRequest(
    {
      params: parsed.request,
      permissions: parsed.permissions,
      expiresInDays: parsed.expiresInDays,
      replacesTokenId: parsed.replacesTokenId,
    },
    consentingUser(ctx),
    env,
    ctx.db
  );
  if (outcome.kind === "refused") return json(outcome.refusal.body, outcome.refusal.status);
  return json({ redirectUrl: outcome.redirectUrl });
}

async function handleToken(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(request, tokenRequestSchema);
  if (parsed instanceof Response) return parsed;
  const response = await exchangeAuthorizationCode(parsed, env, ctx.db, ctx.request_id);
  return response.kind === "token" ? json(response.body) : json(response.body, response.status);
}

export const oauthRoutes = new Hono<ControlPlaneHonoEnv>();

oauthRoutes.get(
  MCP_RESOURCE_METADATA_PATH,
  admit({
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleProtectedResourceMetadata)
);

/** Served only to the web app, which publishes it at the issuer's well-known path. */
const WEB_APP_ONLY = admit({
  ...SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "no-store",
});

oauthRoutes.get("/internal/oauth/authorization-server-metadata", WEB_APP_ONLY, (c) =>
  dispatch(c, handleAuthorizationServerMetadata)
);
// The token response carries the plaintext token, so it is never cached.
oauthRoutes.post("/internal/oauth/token", WEB_APP_ONLY, (c) => dispatch(c, handleToken));

/** The consent page's own routes: a signed-in, active user acting for themselves. */
const CONSENT = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});

oauthRoutes.post("/oauth/authorize/check", CONSENT, (c) => dispatch(c, handleCheck));
oauthRoutes.post("/oauth/authorize/approve", CONSENT, (c) => dispatch(c, handleApprove));
