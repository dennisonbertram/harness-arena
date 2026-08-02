BEGIN;

CREATE TABLE IF NOT EXISTS competition_chat_sequences (
  competition_id TEXT PRIMARY KEY,
  next_sequence BIGINT NOT NULL CHECK (next_sequence > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO competition_chat_sequences (competition_id, next_sequence)
SELECT competition_id, MAX(sequence) + 1
FROM competition_messages
GROUP BY competition_id
ON CONFLICT (competition_id) DO UPDATE
SET next_sequence = GREATEST(competition_chat_sequences.next_sequence, EXCLUDED.next_sequence),
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO schema_migrations (version)
VALUES ('0005_competition_chat_sequences')
ON CONFLICT (version) DO NOTHING;

COMMIT;
