BEGIN;

-- Recovery work may run in several serverless processes. A durable lease
-- fences phase transitions so only one process may perform the next external
-- effect for a pending entry operation. Expiry makes crashed work recoverable;
-- every checkpoint still verifies the exact lease token.
ALTER TABLE competition_entry_sagas
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE competition_entry_sagas
  DROP CONSTRAINT IF EXISTS competition_entry_sagas_lease_pair_check;
ALTER TABLE competition_entry_sagas
  ADD CONSTRAINT competition_entry_sagas_lease_pair_check CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS competition_entry_sagas_recoverable_idx
  ON competition_entry_sagas (lease_expires_at, updated_at)
  WHERE state = 'pending';

INSERT INTO schema_migrations (version)
VALUES ('0011_entry_saga_leases')
ON CONFLICT (version) DO NOTHING;

COMMIT;
