-- Ask: the in-app helper that answers "how do I do X?" from an app's own knowledge.
--
-- Purely additive: four new tables, nothing existing is altered. Every table is
-- keyed by app_id so one Worker serves every registered app.

-- Per-app settings. A row with enabled = 0 (or no row) means Ask is off for that app.
CREATE TABLE ask_config (
    app_id            TEXT PRIMARY KEY REFERENCES apps(id),
    enabled           INTEGER NOT NULL DEFAULT 0,
    assistant_name    TEXT NOT NULL DEFAULT 'Ask',
    product_name      TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    -- Extra rules that differ per app (pricing, off-limits topics), appended to the shared prompt.
    extra_rules       TEXT NOT NULL DEFAULT '',
    -- Where to send someone the helper cannot help, e.g. "Help → Send Feedback in the app".
    support_hint      TEXT NOT NULL DEFAULT 'sending feedback to the developer',
    -- JSON array of starter questions shown in the chat.
    suggestions_json  TEXT NOT NULL DEFAULT '[]',
    model             TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    -- Spend limits. Questions per UTC day across the whole app, split by where they came from.
    daily_cap         INTEGER NOT NULL DEFAULT 1500,
    web_daily_cap     INTEGER NOT NULL DEFAULT 500,
    -- Per installation (app route only).
    per_install_hour  INTEGER NOT NULL DEFAULT 20,
    per_install_day   INTEGER NOT NULL DEFAULT 60,
    -- Comma-separated origins allowed to use the web route, e.g. https://nukeyapp.com.
    web_origins       TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The knowledge text, versioned so a bad publish can be rolled back. The newest
-- version is the live one; publishing prunes all but the last few.
CREATE TABLE ask_knowledge (
    app_id       TEXT NOT NULL REFERENCES apps(id),
    version      INTEGER NOT NULL,
    body         TEXT NOT NULL,
    -- JSON object: guide slug -> title, for "Read the guide" links.
    guides_json  TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (app_id, version)
);

-- Every question and answer, for quality review and the per-installation limits.
-- installation_id is null for web visitors; no IP address is ever stored.
CREATE TABLE ask_log (
    id                 TEXT PRIMARY KEY,
    app_id             TEXT NOT NULL REFERENCES apps(id),
    installation_id    TEXT,
    source             TEXT NOT NULL CHECK (source IN ('app', 'web')),
    question           TEXT NOT NULL,
    answer             TEXT NOT NULL,
    guide              TEXT,
    helpful            INTEGER CHECK (helpful IN (0, 1)),
    knowledge_version  INTEGER,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_ask_log_app ON ask_log(app_id, created_at DESC);
CREATE INDEX idx_ask_log_installation ON ask_log(installation_id, created_at DESC);

-- Daily counters: the spend cap and the cost view. One row per app, day and source.
CREATE TABLE ask_usage (
    app_id             TEXT NOT NULL REFERENCES apps(id),
    day                TEXT NOT NULL,
    source             TEXT NOT NULL CHECK (source IN ('app', 'web')),
    questions          INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, day, source)
);
