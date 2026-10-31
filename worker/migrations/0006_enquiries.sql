-- Messages from developers interested in using Nuke for their own apps,
-- sent through the contact form on the landing page. Read in the admin.

CREATE TABLE enquiries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    app         TEXT,
    message     TEXT NOT NULL,
    handled     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_enquiries_created ON enquiries(handled, created_at);
