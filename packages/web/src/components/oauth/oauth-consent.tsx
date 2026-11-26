"use client";

import { useState } from "react";
import { z } from "zod";
import {
  oauthApprovalResponseSchema,
  type OAuthAuthorizationRequest,
  type OAuthConsentResponse,
} from "@open-inspect/shared/types/oauth";
import {
  isPersonalAccessTokenGrantable,
  isPersonalAccessTokenReadOnlyPermission,
  type PersonalAccessTokenGrantablePermission,
} from "@open-inspect/shared/types/personal-access-tokens";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  DEFAULT_LIFETIME_DAYS,
  fitLifetime,
  lifetimeChoices,
  lifetimeLabel,
} from "@/lib/personal-access-token-lifetimes";
import { formatLastUsed, formatTokenDate } from "@/lib/personal-access-token-display";
import {
  handOffPermissions,
  personalAccessTokenPermissionLabel,
} from "@/lib/personal-access-token-permissions";
import { APP_NAME } from "@/lib/site-config";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RadioCard } from "@/components/ui/form-controls";
import { PersonalAccessTokenPermissionPicker } from "@/components/settings/personal-access-token-permission-picker";

type Consent = Extract<OAuthConsentResponse, { kind: "consent" }>;

type Preset = "read" | "handOff" | "custom";

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((value) => a.has(value));
}

const errorBodySchema = z.object({ error: z.string() });

/** Items as a sentence lists them: `a`, `a and b`, `a, b, and c`. */
function listed(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** What a set of permissions allows, from their labels: "Read sessions and skills". */
function summary(permissions: readonly PersonalAccessTokenGrantablePermission[]): string {
  const labels = permissions.map(personalAccessTokenPermissionLabel);
  const reads = labels.every((label) => label.startsWith("Read "));
  return reads
    ? `Read ${listed(labels.map((label) => label.slice("Read ".length)))}`
    : listed(labels);
}

/**
 * The consent page: which app is asking, where it will return, and what it may do as the user, for
 * how long. Defaults to what the app asked for, which is reading unless the app is stepping up.
 */
export function OAuthConsent({
  consent,
  request,
}: {
  consent: Consent;
  /** The authorization request, sent back with the approval so it is checked again. */
  request: OAuthAuthorizationRequest;
}) {
  const grantable = consent.grantable.filter(isPersonalAccessTokenGrantable);
  const readOnly = consent.readOnly.filter(isPersonalAccessTokenGrantable);
  const handOff = handOffPermissions(grantable, readOnly);
  // Offered only when it adds something the user could grant beyond reading.
  const handOffWrites = handOff.filter(
    (permission) => !isPersonalAccessTokenReadOnlyPermission(permission)
  );
  const lifetimes = lifetimeChoices(consent.maxLifetimeDays);
  const [selected, setSelected] = useState<Set<PersonalAccessTokenGrantablePermission>>(
    () => new Set(consent.requested.filter(isPersonalAccessTokenGrantable))
  );
  const [customizing, setCustomizing] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(() =>
    fitLifetime(DEFAULT_LIFETIME_DAYS, lifetimes)
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Only a grant that writes is a step-up, and only a step-up replaces the token that asked for it.
  const replaces =
    consent.replaces !== null &&
    [...selected].some((permission) => !isPersonalAccessTokenReadOnlyPermission(permission))
      ? consent.replaces
      : null;

  const preset: Preset = sameSet(selected, readOnly)
    ? "read"
    : sameSet(selected, handOff)
      ? "handOff"
      : "custom";

  async function approve() {
    setFailure(null);
    if (selected.size === 0) {
      setFailure("Choose at least one permission, or cancel.");
      return;
    }
    setPending(true);
    try {
      const response = await browserApiFetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request,
          permissions: grantable.filter((permission) => selected.has(permission)),
          expiresInDays,
          replacesTokenId: replaces?.id ?? null,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(body);
        setFailure(parsed.success ? parsed.data.error : "The app could not be allowed; try again.");
        setPending(false);
        return;
      }
      const { redirectUrl } = oauthApprovalResponseSchema.parse(body);
      globalThis.location.assign(redirectUrl);
    } catch {
      setFailure("The app could not be allowed; try again.");
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          Allow <span className="font-mono">{consent.client.host}</span> to use {APP_NAME} as you?
        </h1>
        <p className="text-sm text-muted-foreground">
          The app is served from{" "}
          <span className="font-mono text-foreground">{consent.client.host}</span>
          {consent.client.name !== null && <> and calls itself “{consent.client.name}”</>}. Allowing
          it gives it an access token that acts as you, with only the permissions you choose here,
          and sends you back to{" "}
          <span className="font-mono text-foreground">{consent.redirect.host}</span>.
        </p>
      </div>

      {consent.redirect.loopback && (
        <ErrorBanner role="note">
          This app returns to <span className="font-mono">{consent.redirect.host}</span> on your own
          device. Allow it only if you started this sign-in yourself, from an app you trust.
        </ErrorBanner>
      )}

      {replaces && (
        <p role="note" className="rounded-md border border-border p-3 text-sm text-foreground">
          This replaces your earlier connection from {consent.client.host}, which stops working:{" "}
          {replaces.name}, <span className="font-mono">{replaces.displayPrefix}…</span>, created{" "}
          {formatTokenDate(replaces.createdAt)}, {formatLastUsed(replaces.lastUsedAt).toLowerCase()}
          .
        </p>
      )}

      {failure && <ErrorBanner role="alert">{failure}</ErrorBanner>}

      <fieldset disabled={pending} className="min-w-0 space-y-6">
        <fieldset>
          <legend className="text-sm font-medium text-foreground">Access</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <RadioCard
              name="oauth-access"
              label="Read only"
              description={
                readOnly.length > 0
                  ? `${summary(readOnly)}. Changes nothing.`
                  : "You can grant nothing that only reads."
              }
              checked={preset === "read"}
              disabled={readOnly.length === 0}
              onChange={() => {
                setSelected(new Set(readOnly));
                setCustomizing(false);
              }}
            />
            {handOffWrites.length > 0 && (
              <RadioCard
                name="oauth-access"
                label="Hand off work"
                description={`Also: ${summary(handOffWrites)}.`}
                checked={preset === "handOff"}
                onChange={() => {
                  setSelected(new Set(handOff));
                  setCustomizing(false);
                }}
              />
            )}
          </div>
          {preset === "custom" && !customizing && (
            <p className="mt-2 text-sm text-muted-foreground">
              Requested:{" "}
              {grantable
                .filter((permission) => selected.has(permission))
                .map(personalAccessTokenPermissionLabel)
                .join(", ")}
            </p>
          )}
          <Button
            type="button"
            variant="subtle"
            size="xs"
            className="mt-2"
            aria-expanded={customizing}
            onClick={() => setCustomizing((open) => !open)}
          >
            {customizing ? "Hide permissions" : "Choose permissions"}
          </Button>
          {customizing && (
            <div className="mt-3">
              <PersonalAccessTokenPermissionPicker
                idPrefix="oauth-permission"
                available={grantable}
                selected={selected}
                onChange={setSelected}
              />
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-foreground">Expires in</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {lifetimes.map((days) => (
              <RadioCard
                key={days}
                name="oauth-lifetime"
                label={lifetimeLabel(days)}
                checked={expiresInDays === days}
                onChange={() => setExpiresInDays(days)}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            The app has to sign in again after this. You can revoke it sooner in Settings, under
            Access tokens.
          </p>
        </fieldset>

        <div className="flex gap-2">
          <Button type="button" onClick={() => void approve()}>
            {pending ? "Allowing..." : "Allow"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => globalThis.location.assign(consent.denyUrl)}
          >
            Cancel
          </Button>
        </div>
      </fieldset>
    </main>
  );
}
