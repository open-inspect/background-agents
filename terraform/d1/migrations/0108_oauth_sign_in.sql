-- OAuth sign-in for MCP clients. The access token a client receives is an
-- ordinary personal access token; these changes record which client it was
-- issued to, which clients may sign in, and the authorization codes that
-- stand between consent and the token.

-- The OAuth client (its client ID metadata document URL) a token was issued
-- to through sign-in, or NULL for a token a user created in Settings. Read at
-- authentication: such tokens stop working when MCP clients are turned off.
ALTER TABLE personal_access_tokens ADD COLUMN oauth_client_id TEXT;

-- A user's tokens from one client, for step-up replacement and pruning expired ones.
CREATE INDEX idx_personal_access_tokens_oauth_client
  ON personal_access_tokens(user_id, oauth_client_id)
  WHERE oauth_client_id IS NOT NULL;

-- When /mcp last answered this token with a step-up challenge. A sign-in from the same client
-- within a short window replaces this token if it is the only one of the client's tokens (one
-- per device) challenged then; with two or more, which device is signing in is unknown and none
-- is replaced.
ALTER TABLE personal_access_tokens ADD COLUMN oauth_step_up_requested_at INTEGER;

-- The clients members may sign in to, as a JSON list of client ID metadata
-- document URLs. NULL means the built-in defaults, so a deployment that never
-- edits the list follows them. Part of the API policy, under its revision and
-- audit event.
ALTER TABLE workspace_personal_access_token_policy ADD COLUMN oauth_client_ids_json TEXT;

-- Authorization codes, between the user's approval and the client's token
-- request. Only a SHA-256 hash of the code is stored. A code is bound to the
-- user who approved it and to every parameter the token request must repeat,
-- carries the grant and lifetime chosen at consent, and is claimed at most
-- once. A second presentation marks it replayed, which revokes the token the
-- first one issued (or stops one being issued). Rows are deleted a day after
-- they expire.
CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  expires_in_days INTEGER NOT NULL,
  token_name TEXT NOT NULL,
  -- The earlier token from the same client this approval replaces (step-up).
  replaces_token_id TEXT,
  policy_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  replayed_at INTEGER,
  issued_token_id TEXT
);

CREATE INDEX idx_oauth_authorization_codes_expiry ON oauth_authorization_codes(expires_at);
