/**
 * Control-plane-managed subscription sign-in for OpenCode 2.
 *
 * ChatGPT and SuperGrok subscriptions rotate their refresh tokens, so the
 * control plane keeps them and the sandbox only ever holds short-lived access
 * tokens. Once the server is up, the supervisor stores an expired placeholder
 * credential for each managed provider through OpenCode's credential API. This
 * plugin replaces the refresh of that credential's sign-in method: whenever
 * the credential is within OpenCode's expiry window, OpenCode asks the control
 * plane's token broker instead of the provider.
 *
 * Plain module, no imports: OpenCode loads `export default { id, setup }`.
 */

export const REFRESH_PLACEHOLDER = "managed-by-control-plane";
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

// The sign-in methods the supervisor stores the placeholders under (see
// MANAGED_OAUTH_PROVIDERS in opencode_server.py): Codex-style ChatGPT tokens
// for OpenAI, the device grant for xAI.
export const MANAGED_PROVIDERS = [
  {
    marker: "OPENAI_OAUTH_MANAGED",
    provider: "openai",
    label: "OpenAI",
    method: { id: "chatgpt-browser", type: "oauth", label: "ChatGPT subscription" },
  },
  {
    marker: "XAI_OAUTH_MANAGED",
    provider: "xai",
    label: "xAI",
    method: { id: "device", type: "oauth", label: "SuperGrok subscription" },
  },
];

function sessionId(env) {
  try {
    const config = JSON.parse(env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

export async function fetchAccessToken(provider, label, env = process.env, fetchImpl = fetch) {
  const controlPlaneUrl = env.CONTROL_PLANE_URL;
  const authToken = env.SANDBOX_AUTH_TOKEN;
  const session = sessionId(env);
  if (!controlPlaneUrl || !authToken || !session) {
    throw new Error(`Missing environment for ${label} token refresh`);
  }
  const response = await fetchImpl(
    `${controlPlaneUrl}/sessions/${encodeURIComponent(session)}/provider-auth/${provider}/access-token`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`${label} token refresh failed (${response.status}): ${body}`);
  }
  const result = await response.json();
  const expiresIn = result?.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
  if (
    typeof result?.accessToken !== "string" ||
    !result.accessToken.trim() ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(`Invalid ${label} token broker response`);
  }
  return {
    accessToken: result.accessToken,
    expiresIn,
    accountId: result.providerMetadata?.accountId || null,
  };
}

/** The credential OpenCode stores after a brokered refresh. */
export function brokeredCredential(previous, methodID, token, now = Date.now()) {
  const metadata = token.accountId
    ? { ...previous?.metadata, accountID: token.accountId }
    : previous?.metadata;
  return {
    type: "oauth",
    methodID,
    refresh: REFRESH_PLACEHOLDER,
    access: token.accessToken,
    expires: now + token.expiresIn * 1000,
    ...(metadata ? { metadata } : {}),
  };
}

export function managedProviders(env = process.env) {
  return MANAGED_PROVIDERS.filter((entry) => env[entry.marker]);
}

export default {
  id: "openinspect.provider-auth",
  setup: async (ctx) => {
    const managed = managedProviders();
    if (!managed.length) return;
    // OpenCode's OpenAI plugin reads the ChatGPT account once, from the
    // placeholder that has none, so send the brokered account.
    let chatgptAccountId = null;

    await ctx.integration.transform((editor) => {
      for (const entry of managed) {
        editor.method.update({
          integrationID: entry.provider,
          method: entry.method,
          authorize: async () => {
            throw new Error(`${entry.label} sign-in is managed by Open-Inspect settings`);
          },
          refresh: async (credential) => {
            const token = await fetchAccessToken(entry.provider, entry.label);
            if (entry.provider === "openai" && token.accountId) chatgptAccountId = token.accountId;
            return brokeredCredential(credential, entry.method.id, token);
          },
        });
      }
    });

    if (managed.some((entry) => entry.provider === "openai")) {
      // OpenCode zeroes ChatGPT-plan prices because the subscription pays.
      // Sessions still report the catalog price as the usage's API-equivalent
      // cost, as they did on OpenCode 1.x.
      await ctx.model.transform((models) => {
        const catalog = models.provider.get("openai")?.models;
        if (!catalog) return;
        for (const model of models.list("openai")) {
          const cost = catalog.get(model.id)?.cost;
          if (cost) models.update("openai", model.id, (draft) => void (draft.cost = cost));
        }
      });
      await ctx.session.hook(
        "model.request",
        (event) => {
          if (chatgptAccountId) event.headers["chatgpt-account-id"] = chatgptAccountId;
        },
        { providerID: "openai" }
      );
    }
  },
};
