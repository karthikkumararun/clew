-- Assistant chats, kept on this machine only (spec: ai-assistant › Chat history).
CREATE TABLE ai_chats (
    id            TEXT    PRIMARY KEY,
    connection_id TEXT    NOT NULL,
    -- The first message, shortened.
    title         TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX ai_chats_by_connection ON ai_chats (connection_id, updated_at DESC);

-- One row per message; `body` is the message as the panel keeps it (text, context sent, edits).
CREATE TABLE ai_messages (
    id      TEXT    PRIMARY KEY,
    chat_id TEXT    NOT NULL,
    seq     INTEGER NOT NULL,
    role    TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    body    TEXT    NOT NULL
);
CREATE INDEX ai_messages_by_chat ON ai_messages (chat_id, seq);
