import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { AttestError, fromBase64, sha256, toBase64url, utf8, verifyAssertion } from './appattest';
import { consumeChallenge } from './attest-store';
import { sha256Hex } from './crypto';
import { errors } from './errors';
import { attestMode, type AppContext, type Installation } from './env';

/** Refresh `last_seen_at` at most this often per installation. */
const LAST_SEEN_REFRESH_SECONDS = 60 * 60;

/** Write endpoints that attested installations must sign. */
const ASSERTED_PATHS = new Set(['/api/submit', '/api/reply', '/api/vote', '/api/follow']);

interface InstallationRow {
  id: string;
  app_id: string;
  last_seen_at: string;
  attested: number;
}

/**
 * Resolves the bearer token on a request to an installation.
 * Returns `null` when no Authorization header is present, throws 401 when
 * one is present but invalid. Only the token's SHA-256 is compared or stored.
 */
export async function resolveInstallation(c: Context<AppContext>): Promise<Installation | null> {
  const header = c.req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw errors.unauthorized();

  const tokenHash = await sha256Hex(match[1]!);
  const row = await c.env.DB.prepare(
    'SELECT id, app_id, last_seen_at, attested FROM installations WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first<InstallationRow>();
  if (!row) throw errors.unauthorized();

  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > LAST_SEEN_REFRESH_SECONDS * 1000) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        "UPDATE installations SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
      )
        .bind(row.id)
        .run(),
    );
  }

  return { id: row.id, appId: row.app_id, attested: row.attested === 1 };
}

/**
 * Requires a valid bearer token and stores the installation in
 * `c.var.installation`. On write endpoints, attested installations must
 * also present a valid App Attest assertion (see `verifyRequestAssertion`);
 * in `required` mode unattested installations are refused there.
 */
export const requireInstallation = createMiddleware<AppContext>(async (c, next) => {
  const installation = await resolveInstallation(c);
  if (!installation) throw errors.unauthorized();

  const mode = attestMode(c.env);
  if (mode !== 'off' && ASSERTED_PATHS.has(new URL(c.req.url).pathname)) {
    if (installation.attested) {
      await verifyRequestAssertion(c, installation);
    } else if (mode === 'required') {
      throw attestationError('attestation_required');
    }
  }

  c.set('installation', installation);
  await next();
});

/**
 * Accepts requests with or without a bearer token. A present-but-invalid
 * token is still a 401 so a stale client re-registers instead of silently
 * losing its personal state (votes, follows).
 */
export const optionalInstallation = createMiddleware<AppContext>(async (c, next) => {
  c.set('maybeInstallation', await resolveInstallation(c));
  await next();
});

/** 403 with a code the client recognises as "attest now, then retry". */
function attestationError(code: 'attestation_required' | 'assertion_required' | 'assertion_invalid') {
  return errors.forbidden('This installation must be verified with App Attest.', code);
}

/**
 * Verifies the three assertion headers against the installation's key:
 *
 *   X-Attest-Key          Apple key id
 *   X-Attest-Client-Data  base64 JSON { bodyHash, challenge, method, path } (sorted keys)
 *   X-Attest-Assertion    base64 CBOR from generateAssertion(clientDataHash)
 *
 * The client data binds the assertion to this exact request: method, path,
 * a fresh server challenge, and the SHA-256 of the body.
 */
async function verifyRequestAssertion(c: Context<AppContext>, installation: Installation): Promise<void> {
  const keyID = c.req.header('x-attest-key') ?? '';
  const clientDataHeader = c.req.header('x-attest-client-data') ?? '';
  const assertionHeader = c.req.header('x-attest-assertion') ?? '';
  if (!keyID || !clientDataHeader || !assertionHeader) {
    throw attestationError('assertion_required');
  }

  const stored = await c.env.DB.prepare(
    'SELECT key_id, public_key, counter FROM attest_keys WHERE installation_id = ? AND key_id = ?',
  )
    .bind(installation.id, keyID)
    .first<{ key_id: string; public_key: string; counter: number }>();
  if (!stored) throw attestationError('attestation_required');

  const app = await c.env.DB.prepare('SELECT bundle_id FROM apps WHERE id = ?')
    .bind(installation.appId)
    .first<{ bundle_id: string }>();
  const teamID = (c.env.APPLE_TEAM_ID ?? '').trim();
  if (!app || !teamID) throw errors.forbidden('App Attest is not configured for this app.');

  try {
    const clientData = fromBase64(clientDataHeader);
    const claim = JSON.parse(new TextDecoder().decode(clientData)) as Record<string, unknown>;
    const url = new URL(c.req.url);
    if (claim['method'] !== c.req.method || claim['path'] !== url.pathname) throw new AttestError('request binding');

    const body = await c.req.text();
    const bodyHash = toBase64url(await sha256(utf8(body)));
    if (claim['bodyHash'] !== bodyHash) throw new AttestError('body binding');

    const challenge = typeof claim['challenge'] === 'string' ? claim['challenge'] : '';
    const record = challenge ? await consumeChallenge(c.env.DB, challenge) : null;
    if (!record || record.purpose !== 'assert' || record.path !== url.pathname) throw new AttestError('challenge');

    const verified = await verifyAssertion(
      fromBase64(assertionHeader),
      clientData,
      fromBase64(stored.public_key),
      Number(stored.counter),
      `${teamID}.${app.bundle_id}`,
    );

    await c.env.DB.prepare(
      "UPDATE attest_keys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE key_id = ? AND counter < ?",
    )
      .bind(verified.counter, stored.key_id, verified.counter)
      .run();
  } catch (error) {
    if (error instanceof AttestError || error instanceof SyntaxError) {
      console.warn('App Attest assertion rejected:', error instanceof AttestError ? error.reason : 'client data');
      throw attestationError('assertion_invalid');
    }
    throw error;
  }
}
