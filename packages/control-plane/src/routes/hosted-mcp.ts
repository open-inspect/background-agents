/**
 * The hosted MCP server at `/mcp`.
 *
 * An MCP client connects with a personal access token as its bearer credential: one its user created
 * in Settings, or one issued to it by OAuth sign-in (see `./oauth`). The route itself
 * grants nothing: it checks the API policy's MCP switch, refuses browser origins it does not
 * know, and confirms the token is live, then serves the MCP exchange. Every tool call becomes a
 * request to the control plane's own router, made in-process and carrying the same token, so
 * the route the tool calls admits it, narrows it to its grant, and audits it exactly as it would
 * a direct API call. A tool can therefore do nothing the token could not do without MCP.
 *
 * Stateless: each request is served by a fresh MCP server instance, nothing is kept between
 * requests, and GET and DELETE (2025-era session operations) are answered `405`. One request is
 * one message: batches and `subscriptions/listen` are refused.
 */

import { Hono } from "hono";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { SERVICE_SIGNATURE_HEADER } from "@open-inspect/shared/service-auth";
import { createMcpHandler, originValidationResponse } from "@modelcontextprotocol/server";
import {
  personalAccessTokenPolicyAllows,
  withGrantPrerequisites,
} from "@open-inspect/shared/types/personal-access-tokens";
import { authenticate, isAuthError } from "../auth/authenticate";
import { readPersonalAccessToken } from "../auth/personal-access-token";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { error, json } from "../http/responses";
import { createLogger } from "../logger";
import { McpError } from "../mcp/errors";
import { readMcpBody } from "../mcp/relay";
import { ControlPlaneClient, type ControlPlaneFetch } from "../mcp-tools/client";
import { createHostedMcpServer } from "../mcp-tools/server";
import { TOOLS } from "../mcp-tools/tools";
import { AuthorizationService } from "../authorization/service";
import {
  availableOAuthEndpoints,
  bearerChallenge,
  readOnlyScopes,
  type OAuthEndpoints,
  type OAuthPolicy,
} from "../oauth/server";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { logPrincipal } from "../routing/request-lifecycle";
import { recordPersonalAccessTokenUse } from "../routing/route-admission";
import type { Env } from "../types";
import {
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  type PersonalAccessTokenPrincipal,
  type RequestContext,
} from "./shared";

const logger = createLogger("hosted-mcp");

/** The path the hosted MCP server is served at. */
const HOSTED_MCP_PATH = "/mcp";

/**
 * Largest MCP request body accepted. A tool's arguments are a prompt (capped well below this) or
 * a handful of identifiers, so anything larger is refused before it is parsed.
 */
export const HOSTED_MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Hostnames a browser-originated request may come from: the deployment's own web app and control
 * plane. A request without an `Origin` header (every non-browser client) is not affected.
 */
function allowedOriginHostnames(env: Env): string[] {
  const hostnames: string[] = [];
  for (const value of [env.WEB_APP_URL, env.WORKER_URL]) {
    if (!value) continue;
    try {
      hostnames.push(new URL(value).hostname);
    } catch {
      // A malformed URL allows nothing; the setting is validated where it is used for links.
    }
  }
  return hostnames;
}

/**
 * The refusal of a request without a usable token. While sign-in is available its challenge points
 * the client at the resource metadata and asks for read-only scopes, which is what starts an MCP
 * client's OAuth sign-in.
 */
function unauthorized(
  message: string,
  endpoints: OAuthEndpoints | null,
  policy: OAuthPolicy,
  invalidToken: boolean
): Response {
  const response = error(message, 401);
  response.headers.set(
    "WWW-Authenticate",
    bearerChallenge(endpoints, {
      ...(invalidToken ? { error: "invalid_token" as const } : {}),
      scope: readOnlyScopes(policy),
    })
  );
  return response;
}

/**
 * The step-up challenge for a tool call the token lacks permissions for, or null to let the call
 * run and fail with the permission it lacks.
 *
 * Only a token issued through OAuth sign-in is challenged: its client can sign the user in again
 * for more. A token pasted into a client's configuration is not, since that client has nothing to
 * sign in with, and some refuse to connect at all after a challenge. Nor is a token whose owner
 * could not grant what is missing (they do not hold it, or the policy does not allow it), which
 * would only send the user round the same refusal again.
 *
 * The challenge names everything the token should hold, its grant and what the call needs, since a
 * client may not carry an earlier step-up's scopes into the next. It also marks the token: a
 * sign-in from the same app within the window that grants a write replaces it, if it is the only
 * one of that app's tokens marked then. With two or more marked, which device is signing in is
 * unknown and none is replaced (OAuth carries nothing from the challenge to the sign-in).
 */
async function stepUpChallenge(
  message: unknown,
  principal: PersonalAccessTokenPrincipal,
  endpoints: OAuthEndpoints | null,
  policy: OAuthPolicy,
  ctx: RequestContext,
  client: ControlPlaneClient
): Promise<Response | null> {
  if (endpoints === null || principal.oauthClientId === undefined) return null;
  const call = toolCallOf(message);
  if (call === null) return null;
  const tool = TOOLS.find((candidate) => candidate.name === call.name);
  // A call with invalid arguments would fail whatever the token held: it gets the tool's own
  // error, not a sign-in that ends at the same failure.
  if (!tool || !tool.acceptsArgs(call.arguments)) return null;
  const resolved = await tool.resolveScopes?.(client, call.arguments, principal.grant);
  const needed = [...tool.scopesFor(call.arguments), ...(resolved?.needed ?? [])];
  const missing = needed.filter((permission) => !principal.grant.includes(permission));
  const lookUp = (resolved?.lookUp ?? []).filter(
    (permission) => !principal.grant.includes(permission)
  );
  if (missing.length === 0 && lookUp.length === 0) return null;
  let held: readonly PermissionId[];
  try {
    held = (await new AuthorizationService(ctx.db).getEffectiveAuthorization(principal.userId))
      .permissions;
  } catch {
    // An owner without a role holds nothing; the route the tool calls refuses them as usual.
    return null;
  }
  const grantableNow = (permission: PermissionId) =>
    held.includes(permission) && personalAccessTokenPolicyAllows(policy, permission);
  if (!missing.every(grantableNow)) return null;
  // What would let the next call look further is asked for only where the user can grant it.
  const asked = [...missing, ...lookUp.filter(grantableNow)];
  if (asked.length === 0) return null;
  const scope = withGrantPrerequisites([...principal.grant, ...needed, ...asked]).filter(
    (permission) => personalAccessTokenPolicyAllows(policy, permission)
  );
  // Marks this token as the one asking, for the sign-in this starts (see STEP_UP_REPLACEMENT_WINDOW_MS).
  await new PersonalAccessTokenStore(ctx.db).recordStepUpRequest(principal.tokenId, Date.now());
  const response = json(
    {
      error: "insufficient_scope",
      error_description: `${tool.name} needs ${asked.join(", ")}, which this connection was not granted`,
    },
    403
  );
  response.headers.set(
    "WWW-Authenticate",
    bearerChallenge(endpoints, { error: "insufficient_scope", scope })
  );
  return response;
}

/** The tool a `tools/call` message names, with its arguments; null for any other message. */
function toolCallOf(message: unknown): { name: string; arguments: unknown } | null {
  if (typeof message !== "object" || message === null) return null;
  const { jsonrpc, method, params } = message as {
    jsonrpc?: unknown;
    method?: unknown;
    params?: unknown;
  };
  // Only a JSON-RPC 2.0 request is a tool call; anything else is the MCP handler's to refuse.
  if (jsonrpc !== "2.0" || method !== "tools/call") return null;
  if (typeof params !== "object" || params === null) return null;
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  return typeof name === "string" ? { name, arguments: args ?? {} } : null;
}

/**
 * Serve tool calls through the control plane's own router, under the MCP request's trace so their
 * logs and audit events correlate with it. A tool only ever calls API paths, so a request back to
 * this route would mean a tool was given a path it should never build.
 */
function routerTransport(inProcessFetch: ControlPlaneFetch, traceId: string): ControlPlaneFetch {
  return (request) => {
    if (new URL(request.url).pathname === HOSTED_MCP_PATH) {
      return Promise.resolve(error("Not found", 404));
    }
    const traced = new Request(request);
    traced.headers.set("x-trace-id", traceId);
    return inProcessFetch(traced);
  };
}

/** A JSON-RPC error answered before the MCP server sees the request. */
function rpcError(code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The parsed body of an MCP POST, or the response refusing it. Read here, under the body cap,
 * rather than by the SDK, so the shape can be checked first:
 * - a JSON-RPC batch is refused (the 2025-06-18 revision removed batching), so one request is one
 *   message and cannot fan out into many tool calls;
 * - `subscriptions/listen` is refused: this server is stateless, has nothing to notify, and would
 *   otherwise hold a stream open.
 */
async function readMessage(request: Request): Promise<{ message: unknown } | Response> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readMcpBody(request, HOSTED_MCP_MAX_REQUEST_BODY_BYTES);
  } catch (cause) {
    if (cause instanceof McpError && cause.status === 413) {
      return rpcError(JSON_RPC_INVALID_REQUEST, "Request body too large", 413);
    }
    if (cause instanceof McpError && cause.status === 408) {
      return rpcError(JSON_RPC_INVALID_REQUEST, "Request body timed out", 408);
    }
    throw cause;
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    return rpcError(JSON_RPC_PARSE_ERROR, "Parse error", 400);
  }
  if (Array.isArray(message)) {
    return rpcError(JSON_RPC_INVALID_REQUEST, "Batch requests are not supported", 400);
  }
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { method?: unknown }).method === "subscriptions/listen"
  ) {
    return rpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      "This server is stateless and sends no notifications",
      400
    );
  }
  return { message };
}

/** Per-request inputs the shared handler hands to the server factory. */
interface ExchangeContext {
  client: ControlPlaneClient;
}

/**
 * One handler for every request. The SDK's handler is stateless for this server's traffic; each
 * exchange still gets a fresh MCP server, built around that request's client, so nothing about
 * one caller reaches another.
 */
const mcpHandler = createMcpHandler(
  ({ authInfo }) => {
    const exchange = authInfo?.extra as ExchangeContext | undefined;
    if (!exchange) throw new Error("MCP exchange served without its request context");
    return createHostedMcpServer(exchange.client);
  },
  {
    legacy: "stateless",
    // No tool streams progress, so a 2026-07-28 exchange is one JSON body. (2025-era requests are
    // answered as a short event stream that ends with the result.)
    responseMode: "json",
    maxRequestBodySize: HOSTED_MCP_MAX_REQUEST_BODY_BYTES,
    onerror: (cause) => {
      // The message only: tool arguments can hold prompts and secrets, and are never logged.
      // Ordinary protocol refusals land here too, so this is not a warning.
      logger.info("MCP exchange failed", {
        event: "hosted_mcp.exchange_failed",
        error_message: cause.message,
      });
    },
  }
);

async function serveMcp(
  request: Request,
  env: Env,
  ctx: RequestContext,
  inProcessFetch: ControlPlaneFetch
): Promise<Response> {
  // Off answers as though the route did not exist, before anything about the caller is checked.
  const policy = await new PersonalAccessTokenPolicyStore(ctx.db).get();
  if (!policy.mcpEnabled) return error("Not found", 404);
  const endpoints = availableOAuthEndpoints(env, policy);

  // Compares hostnames only, as the SDK's check does: scheme and port are not considered.
  const rejectedOrigin = originValidationResponse(request, allowedOriginHostnames(env));
  if (rejectedOrigin) return rejectedOrigin;

  // Only a personal access token: a service signature acts for a service, not for one person.
  const token = readPersonalAccessToken(request.headers);
  if (token === null || request.headers.has(SERVICE_SIGNATURE_HEADER)) {
    return unauthorized("A personal access token is required", endpoints, policy, false);
  }
  // Checked here as well as by every route a tool calls, so a revoked or expired token is told so
  // before the client lists tools it could not call.
  const auth = await authenticate(request, env, ctx);
  if (isAuthError(auth)) {
    return auth.status === 401
      ? unauthorized(auth.reason, endpoints, policy, true)
      : error(auth.reason, auth.status);
  }
  logPrincipal(auth.principal, ctx, HOSTED_MCP_PATH);
  if (auth.principal.kind === "personal-access-token") {
    recordPersonalAccessTokenUse(ctx, auth.principal.tokenId);
  }

  let parsedBody: unknown;
  if (request.method === "POST") {
    const read = await readMessage(request);
    if (read instanceof Response) return read;
    parsedBody = read.message;
  }

  const exchange: ExchangeContext = {
    client: new ControlPlaneClient({
      baseUrl: new URL(request.url).origin,
      token,
      fetch: routerTransport(inProcessFetch, ctx.trace_id),
    }),
  };
  if (parsedBody !== undefined && auth.principal.kind === "personal-access-token") {
    const challenge = await stepUpChallenge(
      parsedBody,
      auth.principal,
      endpoints,
      policy,
      ctx,
      exchange.client
    );
    if (challenge) return challenge;
  }
  return mcpHandler.fetch(request, {
    authInfo: { token, clientId: "personal-access-token", scopes: [], extra: { ...exchange } },
    ...(parsedBody === undefined ? {} : { parsedBody }),
  });
}

/**
 * The route authenticates in its handler rather than in admission: it acts for no one itself, and
 * each tool call is admitted by the route it reaches.
 */
const HOSTED_MCP_ROUTE = {
  ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "no-store",
} as const;

export const hostedMcpRoutes = new Hono<ControlPlaneHonoEnv>();

for (const method of ["post", "get", "delete"] as const) {
  hostedMcpRoutes[method](HOSTED_MCP_PATH, admit(HOSTED_MCP_ROUTE), (c) =>
    dispatch(c, (request, env, _params, ctx) => serveMcp(request, env, ctx, c.var.inProcessFetch))
  );
}
