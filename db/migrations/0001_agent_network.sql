BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entrants (
  id UUID PRIMARY KEY,
  github_id BIGINT NOT NULL UNIQUE,
  -- GitHub login is display metadata: the account id, not the mutable login,
  -- is the durable identity key.
  github_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- This records only verified token claims and lifecycle timestamps. Raw bearer
-- or device credentials deliberately never enter this database.
CREATE TABLE IF NOT EXISTS agent_sessions (
  jti UUID PRIMARY KEY,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  key_id TEXT NOT NULL,
  token_version INTEGER NOT NULL CHECK (token_version > 0),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  authenticated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS competition_memberships (
  competition_id TEXT NOT NULL,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  role TEXT NOT NULL DEFAULT 'entrant' CHECK (role IN ('entrant', 'moderator')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'left', 'banned')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMPTZ,
  banned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, entrant_id)
);

CREATE TABLE IF NOT EXISTS submission_bindings (
  submission_id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  entry_kind TEXT NOT NULL DEFAULT 'submission',
  entry_schema_version TEXT NOT NULL DEFAULT 'submission-binding.v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idempotency_operations (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES entrants(id),
  competition_id TEXT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  entity_id TEXT,
  response_json JSONB,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE NULLS NOT DISTINCT (actor_id, competition_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS domain_outbox (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES idempotency_operations(id),
  topic TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  safe_payload JSONB NOT NULL CHECK (jsonb_typeof(safe_payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domain_audit_events (
  id UUID PRIMARY KEY,
  -- System-originated events intentionally have no entrant actor.
  actor_id UUID REFERENCES entrants(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_metadata) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION reject_domain_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'domain_audit_events are append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'domain_audit_events'::regclass
      AND tgname = 'domain_audit_events_reject_mutation'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER domain_audit_events_reject_mutation
      BEFORE UPDATE OR DELETE ON domain_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_domain_audit_event_mutation();
  END IF;
END;
$$;

INSERT INTO schema_migrations (version)
VALUES ('0001_agent_network')
ON CONFLICT (version) DO NOTHING;

COMMIT;
