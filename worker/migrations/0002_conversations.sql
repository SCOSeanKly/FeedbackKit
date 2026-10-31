-- Phase 3: read tracking for private conversations.
--
-- "Read through" is a property of (conversation, side), not of a single
-- message, so it lives here rather than in messages.read_through, which is
-- left in place but unused.

CREATE TABLE conversation_reads (
    submission_id  TEXT NOT NULL REFERENCES submissions(id),
    side           TEXT NOT NULL CHECK (side IN ('user', 'developer')),
    read_through   INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (submission_id, side)
);

CREATE INDEX idx_follows_installation ON follows(installation_id);
CREATE INDEX idx_votes_installation   ON votes(installation_id);
CREATE INDEX idx_issues_roadmap       ON issues(app_id, roadmap_lane);
