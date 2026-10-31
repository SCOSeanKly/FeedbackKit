-- Every status an issue has been in and when it entered it, so the public
-- timeline can draw each issue's journey as coloured segments. Rows are
-- appended by publish and by status edits in the admin; nothing updates them.

CREATE TABLE issue_status_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    TEXT NOT NULL REFERENCES issues(id),
    status      TEXT NOT NULL CHECK (status IN ('reported', 'planned', 'in_progress', 'pending', 'testing', 'complete', 'closed')),
    changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_status_history_issue ON issue_status_history(issue_id, changed_at);

-- Backfill for issues that predate this table. Their real path is unknown, so
-- approximate: still Reported -> one segment from creation; anything else ->
-- Reported from creation until the last update, then the current status.
INSERT INTO issue_status_history (issue_id, status, changed_at)
SELECT id, 'reported', created_at FROM issues;

INSERT INTO issue_status_history (issue_id, status, changed_at)
SELECT id, status, MAX(updated_at, strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+1 second'))
FROM issues WHERE status <> 'reported';
