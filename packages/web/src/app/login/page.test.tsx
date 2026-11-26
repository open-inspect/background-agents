// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  getEnabledSignInProviders: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: mocks.getServerAuthSession,
}));

vi.mock("@/lib/sign-in-providers", () => ({
  getEnabledSignInProviders: mocks.getEnabledSignInProviders,
}));

vi.mock("@/lib/auth-session", () => ({
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import LoginPage, { dynamic } from "./page";

expect.extend(matchers);

function noSearchParams() {
  return { searchParams: Promise.resolve({}) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getServerAuthSession.mockResolvedValue(null);
  mocks.getEnabledSignInProviders.mockResolvedValue(["github", "google"]);
});

afterEach(cleanup);

describe("LoginPage", () => {
  it("renders the request-time provider choices in the React application", async () => {
    render(await LoginPage(noSearchParams()));

    expect(screen.getByRole("heading", { name: "Sign in to Open-Inspect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it.each([
    ["admission_denied", "Your account is not authorized"],
    ["github_email_permission_missing", "Email addresses: Read-only"],
    ["provider_unavailable", "Please try again in a moment"],
    ["admission_unavailable", "Please try again in a moment"],
    ["provider_rejected", "An error occurred during sign in"],
    // Better Auth's own code when a user cancels consent; not an admission denial.
    ["access_denied", "An error occurred during sign in"],
    ["sensitive-unexpected-error", "An error occurred during sign in"],
  ])("explains %s and keeps sign-in available", async (error, message) => {
    render(await LoginPage({ searchParams: Promise.resolve({ error }) }));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(screen.queryByText(/sensitive-unexpected-error/)).not.toBeInTheDocument();
  });

  it("ignores a repeated error parameter", async () => {
    render(
      await LoginPage({
        searchParams: Promise.resolve({ error: ["github_email_permission_missing", "x"] }),
      })
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("redirects an authenticated user before querying providers", async () => {
    mocks.getServerAuthSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada" },
    });
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(LoginPage(noSearchParams())).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/");
    expect(mocks.getEnabledSignInProviders).not.toHaveBeenCalled();
  });

  it.each(["session", "providers"] as const)(
    "renders a sanitized retryable unavailable state when %s resolution fails",
    async (failure) => {
      if (failure === "session") {
        mocks.getServerAuthSession.mockRejectedValue(
          new AuthenticationUnavailableError(new Error("sensitive session error"))
        );
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(
          new AuthenticationUnavailableError(new Error("sensitive provider error"))
        );
      }

      render(await LoginPage(noSearchParams()));

      expect(screen.getByRole("alert")).toHaveTextContent("Sign-in is temporarily unavailable.");
      expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
      expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument();
    }
  );

  it.each(["session", "providers"] as const)(
    "propagates unexpected errors from the %s seam",
    async (failure) => {
      const unexpectedError = new Error(`unexpected ${failure} failure`);
      if (failure === "session") {
        mocks.getServerAuthSession.mockRejectedValue(unexpectedError);
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(unexpectedError);
      }

      await expect(LoginPage(noSearchParams())).rejects.toBe(unexpectedError);
    }
  );

  it("is always rendered at request time", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("LoginPage return-to", () => {
  it("signs in returning to the requested path", async () => {
    const { signIn } = await import("@/lib/auth-session");
    render(
      await LoginPage({ searchParams: Promise.resolve({ returnTo: "/oauth/authorize?state=1" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(signIn).toHaveBeenCalledWith("github", "/oauth/authorize?state=1");
  });

  it("returns a signed-in user to a same-origin path", async () => {
    mocks.getServerAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    await LoginPage({ searchParams: Promise.resolve({ returnTo: "/oauth/authorize?state=1" }) });
    expect(mocks.redirect).toHaveBeenCalledWith("/oauth/authorize?state=1");
  });

  it.each(["https://evil.example/", "//evil.example", ["/a", "/b"]])(
    "sends a signed-in user home instead of to %j",
    async (returnTo) => {
      mocks.getServerAuthSession.mockResolvedValue({ user: { id: "user-1" } });
      await LoginPage({ searchParams: Promise.resolve({ returnTo }) });
      expect(mocks.redirect).toHaveBeenCalledWith("/");
    }
  );
});

describe("LoginPage when sign-in is unavailable", () => {
  it("keeps where it returns to in the retry link", async () => {
    mocks.getServerAuthSession.mockRejectedValue(new AuthenticationUnavailableError(new Error()));
    render(
      await LoginPage({ searchParams: Promise.resolve({ returnTo: "/oauth/authorize?state=1" }) })
    );
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Foauth%2Fauthorize%3Fstate%3D1"
    );
    cleanup();

    mocks.getServerAuthSession.mockResolvedValue(null);
    mocks.getEnabledSignInProviders.mockRejectedValue(
      new AuthenticationUnavailableError(new Error())
    );
    render(await LoginPage({ searchParams: Promise.resolve({ returnTo: "//evil.example" }) }));
    // An unsafe destination is dropped, as it is everywhere else.
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
  });
});
