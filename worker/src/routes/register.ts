import { Hono } from 'hono';
import { newInstallationToken, sha256Hex } from '../crypto';
import { errors } from '../errors';
import { clientIP, enforceLimit } from '../ratelimit';
import { LIMITS, readJSONObject, requireString, scalarLength } from '../validation';
import type { AppContext } from '../env';

/**
 * POST /api/register  { app } -> { token }
 *
 * Creates an installation for a known app and hands back its bearer token.
 * The token is shown exactly once; only its hash is stored.
 *
 * App Attest (phase 4) extends this to a three-step flow without changing the
 * response shape: GET /api/attest/challenge issues a nonce, the client
 * attests its key over that nonce, and this endpoint accepts
 * `{ app, keyId, attestation }`, verifies the statement and stores the key's
 * public key and counter alongside the installation.
 */
export const register = new Hono<AppContext>();

register.post('/', async (c) => {
  await enforceLimit(c.env.REGISTER_IP_LIMIT, clientIP(c));

  const input = await readJSONObject(c);
  const appId = requireString(input, 'app').trim();
  if (appId.length === 0 || scalarLength(appId) > LIMITS.appId.max) {
    throw errors.badRequest('invalid_app', 'app must be a non-empty id.');
  }

  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ id: string }>();
  if (!app) throw errors.notFound('unknown_app', 'No app with that id is registered.');

  const token = newInstallationToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();

  await c.env.DB.prepare('INSERT INTO installations (id, app_id, token_hash) VALUES (?, ?, ?)')
    .bind(id, app.id, tokenHash)
    .run();

  return c.json({ token }, 201);
});
