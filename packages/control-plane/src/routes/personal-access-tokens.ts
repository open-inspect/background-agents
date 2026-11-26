/**
 * Issuing, listing, and revoking one's own personal access tokens.
 *
 * Every route here authenticates a human browser session and declares no `personalAccessTokens`,
 * so a token can never reach them. That is load-bearing: a token that could mint another token
 * would make revocation meaningless, since a leaked credential could issue itself a successor.
 */

import { Hono } from "hono";
import {
  createPersonalAccessTokenRequestSchema,
  type PersonalAccessTokenPolicy,
} from "@open-inspect/shared/types/personal-access-tokens";
import {
  refuseTokenGrant,
  TOKEN_LIMIT_REACHED,
  TOKEN_POLICY_CHANGED,
} from "../auth/personal-access-token-issuance";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  ACTIVE_SELF,
  error,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function handleListTokens(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const tokens = await new PersonalAccessTokenStore(ctx.db).list(ctx.principal.userId);
  return json({ tokens });
}

/** The policy's rules, without the revision only administrators edit against. */
async function handleGetPolicy(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const { enabled, maxLifetimeDays, allowedPermissions } = await new PersonalAccessTokenPolicyStore(
    ctx.db
  ).get();
  const policy: PersonalAccessTokenPolicy = { enabled, maxLifetimeDays, allowedPermissions };
  return json(policy);
}

async function handleIssueToken(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, createPersonalAccessTokenRequestSchema);
  if (parsed instanceof Response) return parsed;
  const policy = await new PersonalAccessTokenPolicyStore(ctx.db).get();
  // Loaded by ACTIVE_SELF admission; a grant may name only what its issuer holds right now.
  const refusal = refuseTokenGrant(
    policy,
    new Set(ctx.authorization?.permissions ?? []),
    parsed.permissions,
    parsed.expiresInDays
  );
  if (refusal) return json(refusal.body, refusal.status);

  const now = Date.now();
  const result = await new PersonalAccessTokenStore(ctx.db).issue({
    userId: ctx.principal.userId,
    name: parsed.name,
    permissions: parsed.permissions,
    expiresAt: now + parsed.expiresInDays * MS_PER_DAY,
    now,
    requestId: ctx.request_id,
    policyRevision: policy.revision,
  });
  if (result.kind !== "issued") {
    const failed = result.kind === "policy_changed" ? TOKEN_POLICY_CHANGED : TOKEN_LIMIT_REACHED;
    return json(failed.body, failed.status);
  }
  // The only response that carries the plaintext token; the route policy keeps it out of caches.
  return json(result.token, 201);
}

async function handleRevokeToken(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const revoked = await new PersonalAccessTokenStore(ctx.db).revoke({
    userId: ctx.principal.userId,
    tokenId: params.id,
    actorUserId: ctx.principal.userId,
    now: Date.now(),
    requestId: ctx.request_id,
  });
  if (!revoked) return error("Personal access token not found", 404);
  return json({ revoked: true });
}

export const personalAccessTokenRoutes = new Hono<ControlPlaneHonoEnv>();

/**
 * One policy for all three routes. `private, no-store` matters: the issue response carries the
 * plaintext token, and a listing names a user's credentials and when each was last used.
 */
const OWN_TOKENS = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});

personalAccessTokenRoutes.get("/personal-access-tokens", OWN_TOKENS, (c) =>
  dispatch(c, handleListTokens)
);
personalAccessTokenRoutes.get("/personal-access-tokens/policy", OWN_TOKENS, (c) =>
  dispatch(c, handleGetPolicy)
);
personalAccessTokenRoutes.post("/personal-access-tokens", OWN_TOKENS, (c) =>
  dispatch(c, handleIssueToken)
);
personalAccessTokenRoutes.delete("/personal-access-tokens/:id", OWN_TOKENS, (c) =>
  dispatch(c, handleRevokeToken)
);
