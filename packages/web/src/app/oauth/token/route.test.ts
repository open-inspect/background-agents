import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as OAuthServer from "@/lib/oauth-server";

const forward = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/oauth-server", async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthServer>()),
  forwardToControlPlane: forward,
}));

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** A token request as Vercel delivers it, with the address it vouches for. */
function tokenRequest(
  body: string,
  headers: Record<string, string> = { ...FORM, "X-Vercel-Forwarded-For": "203.0.113.1" }
) {
  return new Request("https://app.example/oauth/token", { method: "POST", headers, body });
}

/** A token request as Cloudflare Workers deliver it: marked with `cf`. */
function cloudflareRequest(body: string, address: string, extra: Record<string, string> = {}) {
  const request = tokenRequest(body, { ...FORM, "CF-Connecting-IP": address, ...extra });
  Object.defineProperty(request, "cf", { value: {} });
  return request;
}

const EXCHANGE = new URLSearchParams({
  grant_type: "authorization_code",
  code: "the-code",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  code_verifier: "v".repeat(43),
  resource: "https://cp.example/mcp",
  client_secret: "ignored",
}).toString();

beforeEach(() => vi.resetModules());
afterEach(() => vi.resetAllMocks());

describe("POST /oauth/token", () => {
  it("forwards the form's token request fields to the control plane and relays its answer", async () => {
    forward.mockResolvedValue(
      Response.json({ access_token: "oi_pat_x", token_type: "Bearer", expires_in: 60 })
    );
    const { POST } = await import("./route");
    const response = await POST(tokenRequest(EXCHANGE));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ access_token: "oi_pat_x" });
    const [method, path, body] = forward.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/internal/oauth/token"]);
    // Only the fields the exchange takes; anything else the client sent stays here.
    expect(JSON.parse(body as string)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      code_verifier: "v".repeat(43),
      resource: "https://cp.example/mcp",
    });
  });

  it("relays the control plane's OAuth error with its status", async () => {
    forward.mockResolvedValue(
      Response.json({ error: "invalid_grant", error_description: "no" }, { status: 400 })
    );
    const { POST } = await import("./route");
    const response = await POST(tokenRequest(EXCHANGE));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "no",
    });
  });

  it("takes only a form-encoded request, each field once", async () => {
    const { POST } = await import("./route");
    const json = await POST(
      tokenRequest(JSON.stringify({ grant_type: "authorization_code" }), {
        "Content-Type": "application/json",
      })
    );
    expect(json.status).toBe(400);
    await expect(json.json()).resolves.toMatchObject({ error: "invalid_request" });

    const repeated = await POST(tokenRequest(`${EXCHANGE}&code=another`));
    expect(repeated.status).toBe(400);
    const oversized = await POST(tokenRequest(`code=${"x".repeat(20_000)}`));
    expect(oversized.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("limits how often one address Vercel vouches for may ask for a token", async () => {
    vi.stubEnv("VERCEL", "1");
    forward.mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    const { POST, TOKEN_REQUESTS_PER_WINDOW } = await import("./route");
    for (let index = 0; index < TOKEN_REQUESTS_PER_WINDOW; index++) {
      expect((await POST(tokenRequest(EXCHANGE))).status).toBe(400);
    }
    const limited = await POST(tokenRequest(EXCHANGE));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({ error: "invalid_request" });
    // A Cloudflare header a client sets on Vercel names no address: it cannot pick a new bucket.
    const spoofed = await POST(
      tokenRequest(EXCHANGE, {
        ...FORM,
        "X-Vercel-Forwarded-For": "203.0.113.1",
        "CF-Connecting-IP": "198.51.100.7",
      })
    );
    expect(spoofed.status).toBe(429);
    // Another address is unaffected.
    const other = await POST(
      tokenRequest(EXCHANGE, { ...FORM, "X-Vercel-Forwarded-For": "203.0.113.2" })
    );
    expect(other.status).toBe(400);
    expect(forward).toHaveBeenCalledTimes(TOKEN_REQUESTS_PER_WINDOW + 1);
    vi.unstubAllEnvs();
  });

  it("limits by Cloudflare's address on Cloudflare, ignoring a forwarded header", async () => {
    vi.stubEnv("VERCEL", "");
    forward.mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    const { POST, TOKEN_REQUESTS_PER_WINDOW } = await import("./route");
    for (let index = 0; index < TOKEN_REQUESTS_PER_WINDOW; index++) {
      const forwarded = { "X-Forwarded-For": `192.0.2.${index}`, "X-Real-IP": `192.0.2.${index}` };
      expect((await POST(cloudflareRequest(EXCHANGE, "203.0.113.9", forwarded))).status).toBe(400);
    }
    expect((await POST(cloudflareRequest(EXCHANGE, "203.0.113.9"))).status).toBe(429);
    expect((await POST(cloudflareRequest(EXCHANGE, "203.0.113.10"))).status).toBe(400);
    vi.unstubAllEnvs();
  });

  it("does not count requests where the platform vouches for no address", async () => {
    vi.stubEnv("VERCEL", "");
    forward.mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    const { POST, TOKEN_REQUESTS_PER_WINDOW } = await import("./route");
    for (let index = 0; index <= TOKEN_REQUESTS_PER_WINDOW; index++) {
      const response = await POST(
        tokenRequest(EXCHANGE, { ...FORM, "CF-Connecting-IP": "203.0.113.9" })
      );
      expect(response.status).toBe(400);
    }
    vi.unstubAllEnvs();
  });

  it("tells the client to start over, not retry the code, when the exchange's outcome is lost", async () => {
    forward.mockRejectedValue(new Error("unreachable"));
    const { POST } = await import("./route");
    const response = await POST(tokenRequest(EXCHANGE));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: "temporarily_unavailable" });
    expect(body.error_description).toContain("start authorization again; do not retry this code");
    // An unreadable answer is no better: the code may be spent.
    forward.mockResolvedValue(new Response("<html>", { status: 200 }));
    const garbled = await POST(tokenRequest(EXCHANGE));
    expect(garbled.status).toBe(502);
    expect((await garbled.json()).error_description).toContain("do not retry this code");
  });

  it("answers a body that breaks off without forwarding any of it", async () => {
    const { POST } = await import("./route");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("grant_type=authorization_code&code="));
        controller.error(new Error("connection reset"));
      },
    });
    const response = await POST(
      new Request("https://app.example/oauth/token", {
        method: "POST",
        headers: FORM,
        body,
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(forward).not.toHaveBeenCalled();
  });
});
