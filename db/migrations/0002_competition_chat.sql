BEGIN;

CREATE TABLE IF NOT EXISTS competition_messages (
  id UUID PRIMARY KEY,
  competition_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  author_entrant_id UUID NOT NULL REFERENCES entrants(id),
  reply_to_id UUID,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format = 'plain'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (competition_id, sequence),
  UNIQUE (competition_id, id),
  FOREIGN KEY (competition_id, reply_to_id) REFERENCES competition_messages(competition_id, id)
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID NOT NULL REFERENCES competition_messages(id) ON DELETE CASCADE,
  target_entrant_id UUID NOT NULL REFERENCES entrants(id),
  handle_snapshot TEXT NOT NULL,
  PRIMARY KEY (message_id, target_entrant_id)
);

INSERT INTO schema_migrations (version)
VALUES ('0002_competition_chat')
ON CONFLICT (version) DO NOTHING;

COMMIT;
