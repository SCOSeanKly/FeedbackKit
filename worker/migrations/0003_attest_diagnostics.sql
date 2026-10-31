-- Phase 4: App Attest and diagnostics attachments.

-- Single-use challenges for attestation (purpose 'register') and per-request
-- assertions (purpose 'assert'). Rows expire after a few minutes.
CREATE TABLE attest_challenges (
    challenge   TEXT PRIMARY KEY,
    purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'assert')),
    path        TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);

CREATE INDEX idx_attest_challenges_expiry ON attest_challenges(expires_at);

-- One App Attest key per installation. `public_key` is the leaf
-- certificate's SubjectPublicKeyInfo, base64. `counter` is Apple's
-- monotonically increasing assertion counter; a replayed assertion fails
-- because its counter is not greater than the stored one.
CREATE TABLE attest_keys (
    key_id           TEXT PRIMARY KEY,
    installation_id  TEXT NOT NULL UNIQUE REFERENCES installations(id),
    public_key       TEXT NOT NULL,
    counter          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_used_at     TEXT
);

ALTER TABLE installations ADD COLUMN attested INTEGER NOT NULL DEFAULT 0;

-- Optional sanitized JSON the client attached to a report (app version,
-- OS, device model...). Capped at 16 KiB; never rendered publicly.
ALTER TABLE submissions ADD COLUMN diagnostics TEXT;
