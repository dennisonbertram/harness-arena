BEGIN;

ALTER TABLE submission_artifacts DROP CONSTRAINT IF EXISTS submission_artifacts_compression_check;
ALTER TABLE submission_artifacts
  ADD CONSTRAINT submission_artifacts_compression_check CHECK (compression IN ('none', 'gzip'));

ALTER TABLE submission_artifacts
  ADD COLUMN IF NOT EXISTS scan_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (scan_state IN ('pending', 'manual_review', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS scan_revision TEXT,
  ADD COLUMN IF NOT EXISTS scan_summary TEXT,
  ADD COLUMN IF NOT EXISTS policy_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retained_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE submission_artifacts DROP CONSTRAINT IF EXISTS submission_artifacts_policy_metadata_check;
ALTER TABLE submission_artifacts
  ADD CONSTRAINT submission_artifacts_policy_metadata_check CHECK (
    (scan_state = 'approved') = (policy_verified_at IS NOT NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS submission_artifacts_reconcile_policy_idx
  ON submission_artifacts (state, reconcile_after)
  WHERE deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('0006_trace_policy') ON CONFLICT (version) DO NOTHING;
COMMIT;
