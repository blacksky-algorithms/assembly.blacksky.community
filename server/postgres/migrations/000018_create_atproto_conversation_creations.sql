CREATE TABLE IF NOT EXISTS atproto_conversation_creations (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    did TEXT NOT NULL,
    at_uri TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created BIGINT NOT NULL DEFAULT now_as_millis(),
    UNIQUE (zid),
    UNIQUE (did, at_uri)
);

CREATE INDEX IF NOT EXISTS atproto_conversation_creations_did_created_idx
    ON atproto_conversation_creations (did, created);
CREATE INDEX IF NOT EXISTS atproto_conversation_creations_created_idx
    ON atproto_conversation_creations (created);

ALTER TABLE atproto_conversation_creations ADD COLUMN IF NOT EXISTS token_id TEXT;
CREATE INDEX IF NOT EXISTS atproto_conversation_creations_token_id_idx
    ON atproto_conversation_creations (token_id);
