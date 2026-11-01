-- =============================================================================
-- 002. Self-service password reset
-- =============================================================================
--
-- Only the SHA-256 hash of a reset token is ever stored. The raw token exists
-- in exactly two places: the email sent to the account owner, and the URL they
-- click. A leaked database dump therefore yields no working reset links --
-- the same reasoning that puts password_hash here instead of a password.
--
-- Note the deliberate absence of a "revoked" flag: a token is spent by setting
-- `used_at`, and spending is performed with a conditional UPDATE so that two
-- concurrent submissions of the same link cannot both succeed.

CREATE TABLE password_reset_tokens (
  id         integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- CASCADE, not RESTRICT: a reset link has no historical or financial value,
  -- so it must never be the reason a user row cannot be removed. (Compare
  -- orders.client_id, which is RESTRICT precisely because it does have value.)
  user_id    integer      NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- hex(sha256(raw_token)) is always 64 characters. Storing the hex digest
  -- rather than the raw token means a database read does not reveal a token
  -- that can still be used.
  token_hash varchar(64)  NOT NULL,

  expires_at timestamptz  NOT NULL,

  -- NULL until spent. The single-use guarantee lives in this column.
  used_at    timestamptz,

  created_at timestamptz  NOT NULL DEFAULT now()
);

-- Every lookup is by hash. UNIQUE also means a collision (or a bug that inserts
-- the same token twice) fails loudly instead of resolving to an ambiguous row.
CREATE UNIQUE INDEX password_reset_tokens_hash_uniq
  ON password_reset_tokens (token_hash);

-- "invalidate every outstanding token for this user" runs on every reset
-- request and every successful reset; without this it is a sequential scan.
CREATE INDEX password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);

-- Supports the optional expired-token sweep without scanning spent rows.
CREATE INDEX password_reset_tokens_live_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;
