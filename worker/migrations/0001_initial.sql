-- FeedbackKit initial schema.
--
-- Timestamps are ISO 8601 UTC text (second precision) so they read cleanly in
-- the D1 console and decode with Swift's built-in `.iso8601` strategy.
-- Every table from the data model is created now, even those first used in
-- later phases, so there is one migration to reason about.

CREATE TABLE apps (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    bundle_id   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- One row per app installation. Only the SHA-256 of the bearer token is kept;
-- the token itself exists only on the device (Keychain).
CREATE TABLE installations (
    id            TEXT PRIMARY KEY,
    app_id        TEXT NOT NULL REFERENCES apps(id),
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Raw reports. Private: never rendered on a public page.
CREATE TABLE submissions (
    id               TEXT PRIMARY KEY,
    app_id           TEXT NOT NULL REFERENCES apps(id),
    installation_id  TEXT NOT NULL REFERENCES installations(id),
    request_id       TEXT NOT NULL UNIQUE,
    kind             TEXT NOT NULL CHECK (kind IN ('issue', 'idea', 'other')),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'published', 'dismissed')),
    payload_hash     TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_submissions_installation ON submissions(installation_id, created_at DESC);
CREATE INDEX idx_submissions_app_state    ON submissions(app_id, state, created_at DESC);

-- Reviewed, developer-authored copies that appear on the public board.
-- `release` is a SQLite keyword (RELEASE SAVEPOINT), so it is quoted here and
-- must be quoted in every statement that touches it.
CREATE TABLE issues (
    id            TEXT PRIMARY KEY,
    app_id        TEXT NOT NULL REFERENCES apps(id),
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'reported'
                  CHECK (status IN ('reported', 'planned', 'in_progress', 'pending', 'testing', 'complete', 'closed')),
    "release"     TEXT,
    merged_into   TEXT REFERENCES issues(id),
    roadmap_lane  TEXT CHECK (roadmap_lane IN ('now', 'next', 'later')),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    version       INTEGER NOT NULL DEFAULT 1,
    UNIQUE (app_id, number)
);

CREATE INDEX idx_issues_app_status ON issues(app_id, status, updated_at DESC);

CREATE TABLE submission_issue_links (
    submission_id  TEXT NOT NULL REFERENCES submissions(id),
    issue_id       TEXT NOT NULL REFERENCES issues(id),
    PRIMARY KEY (submission_id, issue_id)
);

CREATE INDEX idx_links_issue ON submission_issue_links(issue_id);

CREATE TABLE votes (
    issue_id         TEXT NOT NULL REFERENCES issues(id),
    installation_id  TEXT NOT NULL REFERENCES installations(id),
    PRIMARY KEY (issue_id, installation_id)
);

CREATE TABLE follows (
    issue_id         TEXT NOT NULL REFERENCES issues(id),
    installation_id  TEXT NOT NULL REFERENCES installations(id),
    PRIMARY KEY (issue_id, installation_id)
);

-- Private two-way conversation about one submission. `seq` is per
-- submission and strictly increasing so clients can page with `after`.
CREATE TABLE messages (
    id             TEXT PRIMARY KEY,
    submission_id  TEXT NOT NULL REFERENCES submissions(id),
    sender         TEXT NOT NULL CHECK (sender IN ('user', 'developer')),
    body           TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    request_id     TEXT NOT NULL UNIQUE,
    read_through   INTEGER,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (submission_id, seq)
);
