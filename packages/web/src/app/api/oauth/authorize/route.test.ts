import { afterEach, expect, it, vi } from "vitest";

const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: fetcher }));

import { POST } from "./route";

afterEach(() => vi.resetAllMocks());

const APPROVAL = JSON.stringify({ request: {}, permissions: ["sessions.read"], expiresInDays: 30 });

function approval(fetchSite: string | null) {
  return new Request("https://app.example/api/oauth/authorize", {
    method: "POST",
    headers: fetchSite === null ? {} : { "sec-fetch-site": fetchSite },
    body: APPROVAL,
  });
}

it("forwards the consent page's approval for the signed-in user", async () => {
  fetcher.mockResolvedValue(Response.json({ redirectUrl: "https://claude.ai/cb?code=x" }));
  const response = await POST(approval("same-origin"));
  expect(fetcher).toHaveBeenCalledWith("/oauth/authorize/approve", {
    method: "POST",
    body: APPROVAL,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  await expect(response.json()).resolves.toEqual({ redirectUrl: "https://claude.ai/cb?code=x" });
});

it.each([["cross-site"], ["same-site"], ["none"], [null]])(
  "refuses an approval without same-origin Fetch Metadata (%s)",
  async (fetchSite) => {
    const response = await POST(approval(fetchSite));
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  }
);

it("relays a refusal so the consent page can show it", async () => {
  fetcher.mockResolvedValue(
    Response.json(
      { error: "Too many tokens", code: "personal_access_token_limit_reached" },
      { status: 409 }
    )
  );
  const response = await POST(approval("same-origin"));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: "Too many tokens" });
});

it("answers a body that breaks off with its own error, forwarding nothing", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"request":'));
      controller.error(new Error("connection reset"));
    },
  });
  const response = await POST(
    new Request("https://app.example/api/oauth/authorize", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body,
      duplex: "half",
    } as RequestInit)
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  await expect(response.json()).resolves.toEqual({
    error: "The approval could not be read; try again",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
