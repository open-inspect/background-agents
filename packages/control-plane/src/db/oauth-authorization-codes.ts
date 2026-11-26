/**
 * Authorization codes for OAuth sign-in: what a user approved, held until the client exchanges the
 * code for a token.
 *
 * Only a SHA-256 hash of a code is stored. A code is claimed at most once, by a single guarded
 * update, so two concurrent exchanges cannot both proceed. Presenting a claimed code again marks
 * it replayed: the token it issued is then revoked by the caller, and a token not yet issued never
 * will be, because issuing checks for the mark in the same transaction.
 */

import { isRegisteredPermission, type PermissionId } from "@open-inspect/shared/rbac";
import type { SqlDatabase } from "./sql-database";

/** How long a user's approval stays exchangeable. A client exchanges it at once. */
export const OAUTH_AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a code's row outlives its expiry, so a late replay is still recognized and still
 * revokes what the code issued.
 */
const OAUTH_AUTHORIZATION_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Everything an approval binds a code to. */
export interface OAuthAuthorizationGrant {
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** The PKCE S256 challenge the token request's verifier must answer. */
  readonly codeChallenge: string;
  readonly resource: string;
  readonly permissions: readonly PermissionId[];
  readonly expiresInDays: number;
  /** The name the issued token is listed under. */
  readonly tokenName: string;
  /** The earlier token from the same client to replace, on step-up. */
  readonly replacesTokenId: string | null;
  /** The API policy revision the approval was checked against. */
  readonly policyRevision: number;
}

interface OAuthAuthorizationCode extends OAuthAuthorizationGrant {
  readonly codeHash: string;
  readonly expiresAt: number;
}

/** The outcome of presenting a code. */
export type OAuthCodeClaim =
  | { kind: "claimed"; code: OAuthAuthorizationCode }
  /** Presented before: now marked replayed. `issuedTokenId` is the token the first use issued. */
  | { kind: "replayed"; userId: string; issuedTokenId: string | null }
  | { kind: "unknown" };

interface CodeRow {
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  permissions_json: string;
  expires_in_days: number;
  token_name: string;
  replaces_token_id: string | null;
  policy_revision: number;
  expires_at: number;
}

function toCode(row: CodeRow): OAuthAuthorizationCode {
  const parsed: unknown = JSON.parse(row.permissions_json);
  const permissions = Array.isArray(parsed)
    ? parsed.filter(
        (value): value is PermissionId => typeof value === "string" && isRegisteredPermission(value)
      )
    : [];
  return {
    codeHash: row.code_hash,
    userId: row.user_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    permissions,
    expiresInDays: row.expires_in_days,
    tokenName: row.token_name,
    replacesTokenId: row.replaces_token_id,
    policyRevision: row.policy_revision,
    expiresAt: row.expires_at,
  };
}

export class OAuthAuthorizationCodeStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Records an approval under its code's hash, and clears codes long past their expiry. */
  async create(codeHash: string, grant: OAuthAuthorizationGrant, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM oauth_authorization_codes WHERE expires_at < ?")
        .bind(now - OAUTH_AUTHORIZATION_CODE_RETENTION_MS),
      this.db
        .prepare(
          `INSERT INTO oauth_authorization_codes
             (code_hash, user_id, client_id, redirect_uri, code_challenge, resource,
              permissions_json, expires_in_days, token_name, replaces_token_id, policy_revision,
              created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          codeHash,
          grant.userId,
          grant.clientId,
          grant.redirectUri,
          grant.codeChallenge,
          grant.resource,
          JSON.stringify(grant.permissions),
          grant.expiresInDays,
          grant.tokenName,
          grant.replacesTokenId,
          grant.policyRevision,
          now,
          now + OAUTH_AUTHORIZATION_CODE_TTL_MS
        ),
    ]);
  }

  /**
   * Claims a code for exchange. The first presentation claims it, expired or not, so whatever the
   * caller then decides, the code cannot be used again; every later one marks it replayed.
   */
  async claim(codeHash: string, now: number): Promise<OAuthCodeClaim> {
    const claimed = await this.db
      .prepare(
        `UPDATE oauth_authorization_codes SET consumed_at = ?
          WHERE code_hash = ? AND consumed_at IS NULL
          RETURNING code_hash, user_id, client_id, redirect_uri, code_challenge, resource,
                    permissions_json, expires_in_days, token_name, replaces_token_id,
                    policy_revision, expires_at`
      )
      .bind(now, codeHash)
      .first<CodeRow>();
    if (claimed) return { kind: "claimed", code: toCode(claimed) };
    const replayed = await this.db
      .prepare(
        `UPDATE oauth_authorization_codes SET replayed_at = COALESCE(replayed_at, ?)
          WHERE code_hash = ?
          RETURNING user_id, issued_token_id`
      )
      .bind(now, codeHash)
      .first<{ user_id: string; issued_token_id: string | null }>();
    return replayed
      ? { kind: "replayed", userId: replayed.user_id, issuedTokenId: replayed.issued_token_id }
      : { kind: "unknown" };
  }
}
