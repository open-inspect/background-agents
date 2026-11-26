import { afterEach, expect, it, vi } from "vitest";

import type * as OAuthServer from "@/lib/oauth-server";

const forward = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/oauth-server", async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthServer>()),
  forwardToControlPlane: forward,
}));

import { GET } from "./route";

afterEach(() => vi.resetAllMocks());

it("publishes the control plane's authorization server metadata, readable cross-origin", async () => {
  forward.mockResolvedValue(Response.json({ issuer: "https://app.example" }));
  const response = await GET();
  expect(forward).toHaveBeenCalledWith("GET", "/internal/oauth/authorization-server-metadata");
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  await expect(response.json()).resolves.toEqual({ issuer: "https://app.example" });
});

it("is absent while the control plane says sign-in is unavailable", async () => {
  forward.mockResolvedValue(
    Response.json({ error: "OAuth sign-in is not available" }, { status: 404 })
  );
  expect((await GET()).status).toBe(404);
});
