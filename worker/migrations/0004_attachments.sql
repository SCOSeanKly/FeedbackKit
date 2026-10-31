-- Image attachments. Bytes live in R2 under key "att/<id>"; this table holds
-- ownership and what the image is attached to. An upload starts unlinked and
-- is linked when the message or report that carries it is created; unlinked
-- rows older than a day are swept by the scheduled handler.

CREATE TABLE attachments (
    id               TEXT PRIMARY KEY,
    -- Who uploaded it: an installation (reporter) or NULL for the developer.
    installation_id  TEXT REFERENCES installations(id),
    uploaded_by      TEXT NOT NULL CHECK (uploaded_by IN ('user', 'developer')),
    submission_id    TEXT REFERENCES submissions(id),
    message_id       TEXT REFERENCES messages(id),
    content_type     TEXT NOT NULL,
    bytes            INTEGER NOT NULL,
    width            INTEGER NOT NULL DEFAULT 0,
    height           INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_attachments_message    ON attachments(message_id);
CREATE INDEX idx_attachments_submission ON attachments(submission_id);
CREATE INDEX idx_attachments_orphans    ON attachments(created_at) WHERE message_id IS NULL AND submission_id IS NULL;
