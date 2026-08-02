BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'submission_bindings'::regclass AND conname = 'submission_bindings_submission_owner_key') THEN
    ALTER TABLE submission_bindings ADD CONSTRAINT submission_bindings_submission_owner_key UNIQUE (submission_id, entrant_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS submission_artifacts (
  id UUID PRIMARY KEY,
  submission_id TEXT NOT NULL,
  owner_entrant_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'rationale')),
  schema_version TEXT NOT NULL,
  object_key TEXT NOT NULL CHECK (object_key ~ '^private/'),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  compression TEXT NOT NULL CHECK (compression = 'gzip'),
  compressed_bytes BIGINT NOT NULL CHECK (compressed_bytes BETWEEN 0 AND 1048576),
  uncompressed_bytes BIGINT NOT NULL CHECK (uncompressed_bytes BETWEEN compressed_bytes AND 8388608),
  mime_type TEXT NOT NULL CHECK (mime_type = 'application/json'),
  consent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_upload', 'uploaded', 'verified', 'rejected')),
  reconcile_after TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  UNIQUE (submission_id, kind, schema_version),
  FOREIGN KEY (submission_id, owner_entrant_id) REFERENCES submission_bindings(submission_id, entrant_id)
);

CREATE OR REPLACE FUNCTION reject_verified_artifact_identity_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'verified' THEN
    RAISE EXCEPTION 'verified artifact identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'submission_artifacts'::regclass AND tgname = 'submission_artifacts_immutable_verified') THEN
    CREATE TRIGGER submission_artifacts_immutable_verified BEFORE UPDATE ON submission_artifacts FOR EACH ROW EXECUTE FUNCTION reject_verified_artifact_identity_mutation();
  END IF;
END $$;
INSERT INTO schema_migrations (version) VALUES ('0003_submission_artifacts') ON CONFLICT (version) DO NOTHING;
COMMIT;
