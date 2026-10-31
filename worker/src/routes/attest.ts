import { Hono } from 'hono';
import { AttestError, fromBase64, fromBase64url, toBase64, verifyAttestation } from '../appattest';
import {
  CHALLENGE_PURPOSES,
  CHALLENGE_TTL_SECONDS,
  consumeChallenge,
  issueChallenge,
  type ChallengePurpose,
} from '../attest-store';
import { resolveInstallation } from '../auth';
import { newInstallationToken, sha256Hex } from '../crypto';
import { errors } from '../errors';
import { clientIP, enforceLimit } from '../ratelimit';
import { LIMITS, readJSONObject, requireString, scalarLength } from '../validation';
import { attestMode, type AppContext } from '../env';

/**
 * App Attest endpoints.
 *
 *   POST /api/attest/challenge  { purpose: "register" | "assert", path } -> { challenge }
 *   POST /api/attest/register   { app, keyId, challenge, attestation } -> { token, upgraded }
 *
 * Registration creates an attested installation. If the call carries a
 * valid bearer token for an existing (unattested) installation, the key is
 * bound to that installation instead, so earlier reports stay reachable;
 * `upgraded` is true and the client keeps its current token.
 *
 * Assertions are verified in auth.ts on write endpoints.
 */
export const attest = new Hono<AppContext>();

attest.post('/challenge', async (c) => {
  if (attestMode(c.env) === 'off') throw errors.notFound('attest_disabled', 'App Attest is not enabled on this server.');
  await enforceLimit(c.env.ATTEST_IP_LIMIT, clientIP(c));

  const input = await readJSONObject(c);
  const purpose = requireString(input, 'purpose');
  const path = requireString(input, 'path');
  if (!(CHALLENGE_PURPOSES as readonly string[]).includes(purpose)) {
    throw errors.badRequest('invalid_purpose', 'purpose must be register or assert.');
  }
  if (!path.startsWith('/') || path.length > 200) {
    throw errors.badRequest('invalid_path', 'path must be an absolute request path.');
  }

  const challenge = await issueChallenge(c.env.DB, purpose as ChallengePurpose, path);
  c.header('Cache-Control', 'no-store');
  return c.json({ challenge, expiresIn: CHALLENGE_TTL_SECONDS });
});

attest.post('/register', async (c) => {
  if (attestMode(c.env) === 'off') throw errors.notFound('attest_disabled', 'App Attest is not enabled on this server.');
  await enforceLimit(c.env.ATTEST_IP_LIMIT, clientIP(c));
  const teamID = (c.env.APPLE_TEAM_ID ?? '').trim();
  if (!teamID) throw errors.forbidden('APPLE_TEAM_ID is not configured.');

  const input = await readJSONObject(c);
  const appId = requireString(input, 'app').trim();
  if (appId.length === 0 || scalarLength(appId) > LIMITS.appId.max) {
    throw errors.badRequest('invalid_app', 'app must be a non-empty id.');
  }
  const keyID = requireString(input, 'keyId');
  const challenge = requireString(input, 'challenge');
  const attestationB64 = requireString(input, 'attestation');
  if (keyID.length > 128 || attestationB64.length > 64 * 1024) {
    throw errors.badRequest('invalid_attestation', 'Attestation payload is malformed.');
  }

  const app = await c.env.DB.prepare('SELECT id, bundle_id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ id: string; bundle_id: string }>();
  if (!app) throw errors.notFound('unknown_app', 'No app with that id is registered.');

  // An existing installation may upgrade itself by presenting its token.
  const existing = await resolveInstallation(c);
  if (existing && existing.appId !== app.id) throw errors.forbidden('Token belongs to a different app.');

  const record = await consumeChallenge(c.env.DB, challenge);
  if (!record || record.purpose !== 'register') throw errors.unauthorized();

  let verified;
  try {
    verified = await verifyAttestation(
      fromBase64(attestationB64),
      keyID,
      fromBase64url(challenge),
      `${teamID}.${app.bundle_id}`,
      c.env.ATTEST_ALLOW_DEVELOPMENT === 'true',
    );
  } catch (error) {
    if (error instanceof AttestError) {
      console.warn('App Attest registration rejected:', error.reason);
      throw errors.forbidden('This installation could not be verified.');
    }
    throw error;
  }

  const publicKey = toBase64(verified.spki);
  if (existing) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM attest_keys WHERE installation_id = ?').bind(existing.id),
      c.env.DB.prepare('INSERT INTO attest_keys (key_id, installation_id, public_key) VALUES (?, ?, ?)').bind(
        keyID,
        existing.id,
        publicKey,
      ),
      c.env.DB.prepare('UPDATE installations SET attested = 1 WHERE id = ?').bind(existing.id),
    ]);
    c.header('Cache-Control', 'no-store');
    return c.json({ token: null, upgraded: true });
  }

  const token = newInstallationToken();
  const installationId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO installations (id, app_id, token_hash, attested) VALUES (?, ?, ?, 1)').bind(
      installationId,
      app.id,
      await sha256Hex(token),
    ),
    c.env.DB.prepare('INSERT INTO attest_keys (key_id, installation_id, public_key) VALUES (?, ?, ?)').bind(
      keyID,
      installationId,
      publicKey,
    ),
  ]);
  c.header('Cache-Control', 'no-store');
  return c.json({ token, upgraded: false }, 201);
});
