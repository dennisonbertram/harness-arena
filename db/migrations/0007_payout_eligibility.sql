BEGIN;

-- A freeze records evidence at competition close.  It deliberately contains no
-- amount, settlement, payment, signing, or transfer authority.
CREATE TABLE IF NOT EXISTS payout_eligibility_freezes (
  id UUID PRIMARY KEY,
  competition_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  frozen_by_entrant_id UUID NOT NULL REFERENCES entrants(id),
  status TEXT NOT NULL CHECK (status IN ('eligible', 'ineligible')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'eligible', 'ownership_unreconciled', 'final_result_missing',
    'trace_not_policy_compliant', 'payout_profile_not_effective'
  )),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  cutoff_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ->> 'schema_version' = 'payout-eligibility.v1'
    AND snapshot ->> 'policy_version' = policy_version
  ),
  result_rank INTEGER CHECK (result_rank IS NULL OR result_rank > 0),
  result_score DOUBLE PRECISION,
  judge_revision TEXT,
  trace_sha256 TEXT CHECK (trace_sha256 IS NULL OR trace_sha256 ~ '^[0-9a-f]{64}$'),
  trace_scan_revision TEXT,
  payout_address TEXT,
  payout_chain_id INTEGER CHECK (payout_chain_id IS NULL OR payout_chain_id = 1),
  payout_profile_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (competition_id, submission_id),
  CHECK ((status = 'eligible') = (reason_code = 'eligible')),
  CHECK (status <> 'eligible' OR (
    result_rank IS NOT NULL AND result_score IS NOT NULL AND judge_revision IS NOT NULL
    AND trace_sha256 IS NOT NULL AND trace_scan_revision IS NOT NULL
    AND payout_address IS NOT NULL AND payout_chain_id = 1 AND payout_profile_verified_at IS NOT NULL
  ))
);

CREATE INDEX IF NOT EXISTS payout_eligibility_freezes_owner_idx
  ON payout_eligibility_freezes (entrant_id, competition_id, submission_id);

CREATE OR REPLACE FUNCTION reject_payout_eligibility_freeze_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payout eligibility freezes are immutable';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'payout_eligibility_freezes'::regclass
      AND tgname = 'payout_eligibility_freezes_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payout_eligibility_freezes_immutable
      BEFORE UPDATE OR DELETE ON payout_eligibility_freezes
      FOR EACH ROW EXECUTE FUNCTION reject_payout_eligibility_freeze_mutation();
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('0007_payout_eligibility') ON CONFLICT (version) DO NOTHING;

COMMIT;
