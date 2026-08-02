BEGIN;

-- The saga is deliberately separate from the public submission document. It
-- contains the canonical request (including prompt text) and is never a
-- public-read model.  Each short transaction only advances durable state;
-- callers perform chargeable judging and Blob I/O after it has committed.
CREATE TABLE IF NOT EXISTS competition_entry_sagas (
  operation_id UUID PRIMARY KEY REFERENCES idempotency_operations(id),
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  competition_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  request_json JSONB NOT NULL CHECK (jsonb_typeof(request_json) = 'object'),
  submission_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL DEFAULT 'reserved' CHECK (phase IN ('reserved', 'judge_started', 'verdict_persisted', 'submission_written', 'run_written', 'run_created_appended', 'committed')),
  verdict_json JSONB,
  response_json JSONB,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (entrant_id, competition_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS competition_entry_sagas_pending_idx
  ON competition_entry_sagas (state, phase, updated_at)
  WHERE state = 'pending';

INSERT INTO schema_migrations (version)
VALUES ('0008_entry_saga')
ON CONFLICT (version) DO NOTHING;

COMMIT;
