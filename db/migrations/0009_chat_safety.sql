BEGIN;

-- Safety state is deliberately room-scoped: no participant content is copied
-- into quota or audit records.
CREATE TABLE IF NOT EXISTS competition_chat_quotas (
  competition_id TEXT NOT NULL,
  entrant_id UUID NOT NULL REFERENCES entrants(id),
  window_started_at TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, entrant_id)
);

ALTER TABLE competition_messages
  ADD COLUMN IF NOT EXISTS tombstoned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tombstoned_by_entrant_id UUID REFERENCES entrants(id);

CREATE TABLE IF NOT EXISTS competition_chat_audit_events (
  id UUID PRIMARY KEY,
  competition_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('entrant.banned', 'message.tombstoned')),
  actor_entrant_id UUID NOT NULL REFERENCES entrants(id),
  entrant_id UUID REFERENCES entrants(id),
  message_id UUID REFERENCES competition_messages(id),
  operation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_entrant_id, competition_id, action, operation_id),
  CHECK ((action = 'entrant.banned' AND entrant_id IS NOT NULL AND message_id IS NULL)
      OR (action = 'message.tombstoned' AND message_id IS NOT NULL AND entrant_id IS NULL))
);

CREATE OR REPLACE FUNCTION reject_competition_chat_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'competition chat audit events are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION reject_message_mention_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'message mentions are immutable';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'competition_chat_audit_events'::regclass AND tgname = 'competition_chat_audit_events_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER competition_chat_audit_events_immutable
      BEFORE UPDATE OR DELETE ON competition_chat_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_competition_chat_audit_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'message_mentions'::regclass AND tgname = 'message_mentions_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER message_mentions_immutable
      BEFORE UPDATE OR DELETE ON message_mentions
      FOR EACH ROW EXECUTE FUNCTION reject_message_mention_mutation();
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('0009_chat_safety') ON CONFLICT (version) DO NOTHING;

COMMIT;
