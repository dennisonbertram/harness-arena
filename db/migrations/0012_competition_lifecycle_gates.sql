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

INSERT INTO schema_migrations (version)
VALUES ('0012_competition_lifecycle_gates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
