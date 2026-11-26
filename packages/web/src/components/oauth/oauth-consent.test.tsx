// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthConsentResponse } from "@open-inspect/shared/types/oauth";
import { OAuthConsent } from "./oauth-consent";

expect.extend(matchers);

type Consent = Extract<OAuthConsentResponse, { kind: "consent" }>;

const REQUEST = {
  response_type: "code",
  client_id: "https://client.example/metadata",
  redirect_uri: "https://client.example/callback",
  state: "state-1",
};

const CONSENT: Consent = {
  kind: "consent",
  client: { id: REQUEST.client_id, host: "client.example", name: "Example App" },
  redirect: { host: "client.example", loopback: false },
  requested: ["sessions.read"],
  grantable: [
    "automations.read",
    "environments.read",
    "environments.use",
    "repositories.read",
    "repositories.use",
    "sessions.collaborate",
    "sessions.create",
    "sessions.lifecycle",
    "sessions.read",
    "workspace.audit.read",
  ],
  readOnly: ["automations.read", "sessions.read"],
  maxLifetimeDays: 90,
  replaces: null,
  denyUrl: "https://client.example/callback?error=access_denied&state=state-1",
};

const assign = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { origin: "https://app.example", assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function approvalBody(): { permissions: string[]; expiresInDays: number; request: unknown } {
  const [, init] = fetchMock.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string);
}

describe("OAuthConsent", () => {
  it("names the app by its host and grants what it asked for, for 30 days, by default", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ redirectUrl: "https://client.example/callback?code=c&state=state-1" })
    );
    const user = userEvent.setup();
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);

    expect(screen.getByRole("heading")).toHaveTextContent("Allow client.example to use");
    expect(screen.getByText(/calls itself “Example App”/)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /30 days/ })).toBeChecked();
    // Lifetimes stop at the policy's cap.
    expect(screen.getByRole("radio", { name: /90 days/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /180 days/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/authorize",
      expect.objectContaining({ method: "POST", mode: "same-origin" })
    );
    expect(approvalBody()).toEqual({
      request: REQUEST,
      permissions: ["sessions.read"],
      expiresInDays: 30,
      replacesTokenId: null,
    });
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://client.example/callback?code=c&state=state-1")
    );
  });

  it("offers a hand-off choice that starts and prompts sessions", async () => {
    fetchMock.mockResolvedValue(Response.json({ redirectUrl: "https://client.example/callback" }));
    const user = userEvent.setup();
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);

    await user.click(screen.getByRole("radio", { name: /Hand off work/ }));
    await user.click(screen.getByRole("radio", { name: /7 days/ }));
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(approvalBody()).toMatchObject({
      // The read-only choice plus what handing off work takes; not every read the user holds.
      permissions: [
        "automations.read",
        "environments.read",
        "environments.use",
        "repositories.read",
        "repositories.use",
        "sessions.collaborate",
        "sessions.create",
        "sessions.read",
      ],
      expiresInDays: 7,
    });
  });

  it("describes the read-only choice from what it grants", () => {
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);
    expect(screen.getByRole("radio", { name: /Read only/ })).toHaveAccessibleName(
      expect.stringContaining("Read automations and sessions. Changes nothing.")
    );
    expect(screen.getByRole("radio", { name: /Hand off work/ })).toHaveAccessibleName(
      expect.stringContaining(
        "Also: Use environments, Use repositories, Collaborate in sessions, and Create sessions."
      )
    );
  });

  it("does not offer handing off work to a user who could grant none of its writes", () => {
    render(
      <OAuthConsent
        consent={{
          ...CONSENT,
          // A viewer: reads only.
          grantable: [
            "automations.read",
            "environments.read",
            "repositories.read",
            "sessions.read",
          ],
          readOnly: ["automations.read", "sessions.read"],
        }}
        request={REQUEST}
      />
    );
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Hand off work/ })).not.toBeInTheDocument();
  });

  it("lets the user choose permissions beyond the choices", async () => {
    fetchMock.mockResolvedValue(Response.json({ redirectUrl: "https://client.example/callback" }));
    const user = userEvent.setup();
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);
    await user.click(screen.getByRole("radio", { name: /Read only/ }));
    await user.click(screen.getByRole("button", { name: "Choose permissions" }));
    await user.click(screen.getByLabelText("Manage session lifecycle"));
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(approvalBody().permissions).toEqual([
      "automations.read",
      "sessions.lifecycle",
      "sessions.read",
    ]);
  });

  it("replaces the connection that asked to step up only when the grant writes", async () => {
    fetchMock.mockResolvedValue(Response.json({ redirectUrl: "https://client.example/callback" }));
    const user = userEvent.setup();
    const { unmount } = render(
      <OAuthConsent
        consent={{
          ...CONSENT,
          requested: ["sessions.collaborate", "sessions.read"],
          replaces: {
            id: "token-1",
            name: "Example App (client.example)",
            displayPrefix: "oi_pat_a1b2c3",
            createdAt: Date.UTC(2026, 0, 2),
            lastUsedAt: Date.now() - 5 * 60 * 1000,
          },
        }}
        request={REQUEST}
      />
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "This replaces your earlier connection from client.example"
    );
    // Two tokens of one app created the same day are told apart by prefix and last use.
    expect(screen.getByRole("note")).toHaveTextContent("oi_pat_a1b2c3…");
    expect(screen.getByRole("note")).toHaveTextContent("last used 5m ago");
    expect(
      screen.getByText(/Requested: Collaborate in sessions, Read sessions/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(approvalBody()).toMatchObject({
      permissions: ["sessions.collaborate", "sessions.read"],
      replacesTokenId: "token-1",
    });
    unmount();

    // Choosing reads alone is not a step-up: nothing is replaced.
    fetchMock.mockClear();
    render(
      <OAuthConsent
        consent={{
          ...CONSENT,
          requested: ["sessions.collaborate", "sessions.read"],
          replaces: {
            id: "token-1",
            name: "x",
            displayPrefix: "oi_pat_a1b2c3",
            createdAt: 0,
            lastUsedAt: null,
          },
        }}
        request={REQUEST}
      />
    );
    await user.click(screen.getByRole("radio", { name: /Read only/ }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(approvalBody()).toMatchObject({
      permissions: ["automations.read", "sessions.read"],
      replacesTokenId: null,
    });
  });

  it("warns that a loopback redirect returns to an app on this device", () => {
    render(
      <OAuthConsent
        consent={{ ...CONSENT, redirect: { host: "127.0.0.1:43123", loopback: true } }}
        request={REQUEST}
      />
    );
    expect(screen.getByRole("note")).toHaveTextContent("127.0.0.1:43123 on your own device");
  });

  it("shows a refusal on the page and stays", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: "You already hold 50 personal access tokens; revoke one first" },
        { status: 409 }
      )
    );
    const user = userEvent.setup();
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already hold 50");
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("returns to the app with access_denied on cancel", async () => {
    const user = userEvent.setup();
    render(<OAuthConsent consent={CONSENT} request={REQUEST} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(assign).toHaveBeenCalledWith(CONSENT.denyUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
