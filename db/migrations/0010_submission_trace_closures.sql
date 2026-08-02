BEGIN;

-- A close is durable evidence, not merely an audit event. Both artifact
-- preparation and close lock the binding row so no later trace can appear
-- outside the immutable close snapshot.
CREATE TABLE IF NOT EXISTS submission_trace_closures (
  submission_id TEXT PRIMARY KEY REFERENCES submission_bindings(submission_id),
  owner_entrant_id UUID NOT NULL REFERENCES entrants(id),
  snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ->> 'schema_version' = 'submission-trace-close.v1'
    AND jsonb_typeof(snapshot -> 'artifact_ids') = 'array'
    AND jsonb_typeof(snapshot -> 'artifact_shas') = 'array'
  ),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION reject_submission_trace_closure_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'submission trace closures are immutable';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'submission_trace_closures'::regclass AND tgname = 'submission_trace_closures_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER submission_trace_closures_immutable
      BEFORE UPDATE OR DELETE ON submission_trace_closures
      FOR EACH ROW EXECUTE FUNCTION reject_submission_trace_closure_mutation();
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('0010_submission_trace_closures') ON CONFLICT (version) DO NOTHING;

COMMIT;
