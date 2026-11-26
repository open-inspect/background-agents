// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthConsentResponse } from "@open-inspect/shared/types/oauth";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  controlPlaneUserFetch: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: mocks.getServerAuthSession,
}));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: mocks.controlPlaneUserFetch }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import OAuthAuthorizePage from "./page";

expect.extend(matchers);

const REQUEST = {
  response_type: "code",
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  state: "state-1",
  scope: "sessions.read",
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
};

const CONSENT: OAuthConsentResponse = {
  kind: "consent",
  client: { id: REQUEST.client_id, host: "claude.ai", name: "Claude" },
  redirect: { host: "claude.ai", loopback: false },
  requested: ["sessions.read"],
  grantable: ["sessions.read", "sessions.create", "sessions.collaborate"],
  readOnly: ["sessions.read"],
  maxLifetimeDays: 365,
  replaces: null,
  denyUrl: "https://claude.ai/api/mcp/auth_callback?error=access_denied",
};

function page(query: Record<string, string | string[]> = REQUEST) {
  return OAuthAuthorizePage({ searchParams: Promise.resolve(query) });
}

beforeEach(() => {
  mocks.getServerAuthSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.controlPlaneUserFetch.mockResolvedValue(Response.json(CONSENT));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the OAuth consent page", () => {
  it("sends a signed-out user to sign in, returning to this exact request, before checking it", async () => {
    mocks.getServerAuthSession.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    const [destination] = mocks.redirect.mock.calls[0]!;
    const url = new URL(destination, "https://app.example");
    expect(url.pathname).toBe("/login");
    const returnTo = new URL(url.searchParams.get("returnTo")!, "https://app.example");
    expect(returnTo.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(returnTo.searchParams)).toEqual(REQUEST);
    // Nothing about the app is looked up for a visitor who is not signed in.
    expect(mocks.controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("checks the request with the control plane and shows consent naming the app's host", async () => {
    render(await page());
    expect(mocks.controlPlaneUserFetch).toHaveBeenCalledWith("/oauth/authorize/check", {
      method: "POST",
      body: JSON.stringify(REQUEST),
    });
    expect(
      screen.getByRole("heading", { name: /Allow claude\.ai to use .* as you\?/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });

  it("shows a request the control plane refuses on the page, without redirecting", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(
      Response.json({
        kind: "error",
        code: "oauth_client_untrusted",
        message: "This app is not one the workspace allows to sign in.",
      })
    );
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("not one the workspace allows");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sends a malformed request from a verified app back to it", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(
      Response.json({ kind: "redirect", url: "https://claude.ai/cb?error=invalid_request" })
    );
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("https://claude.ai/cb?error=invalid_request");
  });

  it("refuses a request too long to survive signing in, before anything else", async () => {
    // Within each parameter's own limit, but longer than sign-in can return to once encoded.
    mocks.getServerAuthSession.mockResolvedValue(null);
    render(await page({ ...REQUEST, state: "/".repeat(3000) }));
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("refuses a request that repeats a parameter", async () => {
    render(await page({ ...REQUEST, redirect_uri: ["https://a.example", "https://b.example"] }));
    expect(screen.getByRole("alert")).toHaveTextContent("not valid");
    expect(mocks.controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("explains a suspended user's refusal", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(
      Response.json({ error: "Forbidden", code: "active_user_required" }, { status: 403 })
    );
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("Your workspace access is disabled.");
  });

  it("shows any other refusal of the user as it was given, not as a suspension", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(
      Response.json(
        { error: "A role assignment is required", code: "assignment_required" },
        { status: 403 }
      )
    );
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("A role assignment is required");
    expect(screen.getByRole("alert")).not.toHaveTextContent("disabled");
  });

  it("explains when signing in is unavailable", async () => {
    mocks.getServerAuthSession.mockRejectedValue(new AuthenticationUnavailableError(new Error()));
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable");
  });
});
