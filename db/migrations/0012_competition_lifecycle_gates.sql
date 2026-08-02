BEGIN;

-- Blob competition documents remain the public read model, but close must be
-- serialized with durable entry reservations/final commits.  This small SQL
-- gate is the authoritative write-side boundary for that race.
CREATE TABLE IF NOT EXISTS competition_lifecycle_gates (
  competition_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('live', 'closed')),
  close_generation UUID UNIQUE,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (state = 'live' AND close_generation IS NULL AND closed_at IS NULL)
    OR (state = 'closed' AND close_generation IS NOT NULL AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS competition_lifecycle_gates_generation_idx
  ON competition_lifecycle_gates (competition_id, close_generation);

-- One immutable batch is the lineage root for every close-time eligibility
-- row. Existing pre-feature freeze rows may keep a NULL generation; all rows
-- written by the versioned service below are pinned to a real closed gate.
CREATE TABLE IF NOT EXISTS payout_freeze_batches (
  competition_id TEXT PRIMARY KEY,
  close_generation UUID NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  expected_submission_count INTEGER NOT NULL CHECK (expected_submission_count >= 0),
  frozen_by_entrant_id UUID NOT NULL REFERENCES entrants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (competition_id, close_generation),
  FOREIGN KEY (competition_id, close_generation)
    REFERENCES competition_lifecycle_gates (competition_id, close_generation)
);

ALTER TABLE payout_eligibility_freezes
  ADD COLUMN IF NOT EXISTS close_generation UUID;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payout_eligibility_freezes'::regclass
      AND conname = 'payout_eligibility_freezes_batch_fk'
  ) THEN
    ALTER TABLE payout_eligibility_freezes
      ADD CONSTRAINT payout_eligibility_freezes_batch_fk
      FOREIGN KEY (competition_id, close_generation)
      REFERENCES payout_freeze_batches (competition_id, close_generation);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_competition_lifecycle_reopen()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'closed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed competition lifecycle gates are immutable';
  END IF;
  IF OLD.state = 'live' AND NEW.state <> 'closed' THEN
    RAISE EXCEPTION 'competition lifecycle gates may only transition live to closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_payout_freeze_batch_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payout freeze batches are immutable';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'competition_lifecycle_gates'::regclass
      AND tgname = 'competition_lifecycle_transition_guard'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER competition_lifecycle_transition_guard
      BEFORE UPDATE ON competition_lifecycle_gates
      FOR EACH ROW EXECUTE FUNCTION reject_competition_lifecycle_reopen();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'payout_freeze_batches'::regclass
      AND tgname = 'payout_freeze_batches_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payout_freeze_batches_immutable
      BEFORE UPDATE OR DELETE ON payout_freeze_batches
      FOR EACH ROW EXECUTE FUNCTION reject_payout_freeze_batch_mutation();
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('0012_competition_lifecycle_gates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
