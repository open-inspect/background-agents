import assert from "node:assert/strict";
import { test } from "node:test";

import plugin, {
  REFRESH_PLACEHOLDER,
  brokeredCredential,
  fetchAccessToken,
} from "../src/sandbox_runtime/plugins/provider-auth.js";

const ENV = {
  CONTROL_PLANE_URL: "https://cp.example",
  SANDBOX_AUTH_TOKEN: "sandbox-token",
  SESSION_CONFIG: JSON.stringify({ sessionId: "session-1" }),
};

function broker(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

test("asks the session's token broker with the sandbox token", async () => {
  const { calls, fetchImpl } = broker({
    accessToken: "access-1",
    expiresIn: 600,
    providerMetadata: { accountId: "acct-1" },
  });
  const token = await fetchAccessToken("openai", "OpenAI", ENV, fetchImpl);
  assert.deepEqual(token, { accessToken: "access-1", expiresIn: 600, accountId: "acct-1" });
  assert.equal(
    calls[0].url,
    "https://cp.example/sessions/session-1/provider-auth/openai/access-token"
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sandbox-token");
});

test("rejects a failed or malformed broker response", async () => {
  await assert.rejects(
    fetchAccessToken("xai", "xAI", ENV, broker({ error: "revoked" }, 401).fetchImpl),
    /xAI token refresh failed \(401\)/
  );
  await assert.rejects(
    fetchAccessToken("xai", "xAI", ENV, broker({ accessToken: " " }).fetchImpl),
    /Invalid xAI token broker response/
  );
  await assert.rejects(
    fetchAccessToken("xai", "xAI", { ...ENV, SANDBOX_AUTH_TOKEN: "" }, broker({}).fetchImpl),
    /Missing environment/
  );
});

test("stores the brokered token with the placeholder refresh and the account", () => {
  const previous = { type: "oauth", methodID: "chatgpt-browser", metadata: { other: "kept" } };
  const credential = brokeredCredential(
    previous,
    "chatgpt-browser",
    { accessToken: "access-2", expiresIn: 60, accountId: "acct-2" },
    1_000
  );
  assert.deepEqual(credential, {
    type: "oauth",
    methodID: "chatgpt-browser",
    refresh: REFRESH_PLACEHOLDER,
    access: "access-2",
    expires: 61_000,
    metadata: { other: "kept", accountID: "acct-2" },
  });
  const xai = brokeredCredential(
    {},
    "device",
    { accessToken: "a", expiresIn: 1, accountId: null },
    0
  );
  assert.equal("metadata" in xai, false);
});

function fakeContext() {
  const registered = [];
  const hooks = [];
  const transforms = [];
  return {
    registered,
    hooks,
    transforms,
    ctx: {
      integration: {
        transform: async (callback) =>
          callback({ method: { update: (registration) => registered.push(registration) } }),
      },
      model: { transform: async (callback) => transforms.push(callback) },
      session: { hook: async (name, callback, options) => hooks.push({ name, callback, options }) },
    },
  };
}

test("replaces only the managed providers' sign-in methods", async () => {
  const previous = { ...process.env };
  try {
    process.env.XAI_OAUTH_MANAGED = "1";
    delete process.env.OPENAI_OAUTH_MANAGED;
    const { ctx, registered, hooks } = fakeContext();
    await plugin.setup(ctx);
    assert.deepEqual(
      registered.map((entry) => [entry.integrationID, entry.method.id]),
      [["xai", "device"]]
    );
    assert.equal(hooks.length, 0);
    await assert.rejects(registered[0].authorize({}), /managed by Open-Inspect/);
  } finally {
    process.env = previous;
  }
});

test("restores ChatGPT catalog prices and sends the brokered account", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, ENV, { OPENAI_OAUTH_MANAGED: "1" });
    globalThis.fetch = broker({
      accessToken: "access-3",
      expiresIn: 600,
      providerMetadata: { accountId: "acct-3" },
    }).fetchImpl;
    const { ctx, registered, hooks, transforms } = fakeContext();
    await plugin.setup(ctx);

    const price = [{ input: 1, output: 2 }];
    const models = [{ id: "gpt-6.1-sol", cost: [] }];
    transforms[0]({
      provider: { get: () => ({ models: new Map([["gpt-6.1-sol", { cost: price }]]) }) },
      list: () => models,
      update: (_provider, id, update) => update(models.find((model) => model.id === id)),
    });
    assert.deepEqual(models[0].cost, price);

    const request = { headers: {} };
    hooks[0].callback(request);
    assert.deepEqual(request.headers, {});
    const refreshed = await registered[0].refresh({ type: "oauth", methodID: "chatgpt-browser" });
    assert.equal(refreshed.access, "access-3");
    assert.deepEqual(hooks[0].options, { providerID: "openai" });
    hooks[0].callback(request);
    assert.equal(request.headers["chatgpt-account-id"], "acct-3");
  } finally {
    process.env = previous;
    globalThis.fetch = originalFetch;
  }
});
