import { toBase64url } from './appattest';

/**
 * Single-use App Attest challenges, kept in D1 (no KV in this project).
 * Shared by the attest routes (issue) and the auth middleware (consume).
 */

export const CHALLENGE_TTL_SECONDS = 300;
export const CHALLENGE_PURPOSES = ['register', 'assert'] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

export interface ChallengeRecord {
  purpose: ChallengePurpose;
  path: string;
}

/** Issues a challenge bound to a purpose and request path, pruning expired rows. */
export async function issueChallenge(db: D1Database, purpose: ChallengePurpose, path: string): Promise<string> {
  const challenge = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.batch([
    db.prepare("DELETE FROM attest_challenges WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"),
    db.prepare('INSERT INTO attest_challenges (challenge, purpose, path, expires_at) VALUES (?, ?, ?, ?)').bind(
      challenge,
      purpose,
      path,
      expires,
    ),
  ]);
  return challenge;
}

/** Consumes a challenge. Returns null if unknown, expired, or already used. */
export async function consumeChallenge(db: D1Database, challenge: string): Promise<ChallengeRecord | null> {
  const row = await db
    .prepare(
      `DELETE FROM attest_challenges
       WHERE challenge = ? AND expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       RETURNING purpose, path`,
    )
    .bind(challenge)
    .first<ChallengeRecord>();
  return row ?? null;
}
