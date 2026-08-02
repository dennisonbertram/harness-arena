BEGIN;

-- Only public address-verification state is retained.  Wallet signatures and
-- the source nonce are deliberately never persisted.
CREATE TABLE IF NOT EXISTS address_challenges (
  id UUID PRIMARY KEY,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 1),
  nonce_hash TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  idempotency_key TEXT,
  request_hash TEXT CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  response_json JSONB CHECK (response_json IS NULL OR jsonb_typeof(response_json) = 'object'),
  CHECK (expires_at > issued_at)
);

CREATE TABLE IF NOT EXISTS payout_profiles (
  entrant_id UUID PRIMARY KEY REFERENCES entrants(id),
  provider TEXT NOT NULL CHECK (provider = 'external'),
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 1),
  verification_method TEXT NOT NULL CHECK (verification_method = 'eip191'),
  consent_version TEXT NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 128),
  verified_at TIMESTAMPTZ NOT NULL,
  change_effective_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS address_challenges_owner_idx
  ON address_challenges (entrant_id, expires_at);

INSERT INTO schema_migrations (version)
VALUES ('0004_payout_profiles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
