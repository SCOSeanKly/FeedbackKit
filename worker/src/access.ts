import { createMiddleware } from 'hono/factory';
import { errors } from './errors';
import type { AppContext } from './env';

/**
 * Cloudflare Access protection for /admin.
 *
 * Access sits in front of the hostname and only lets signed-in users through,
 * but anyone who knows the *.workers.dev address could call the Worker
 * directly. So the Worker also verifies the JWT Access injects in
 * `Cf-Access-Jwt-Assertion`: RS256 signature against the team's published
 * keys, plus audience, issuer and expiry. No custom login code anywhere.
 *
 * Configuration (wrangler.toml [vars] or the dashboard):
 *   ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com"
 *   ACCESS_AUD          the Access application's Audience (AUD) tag
 *
 * Local development: when ACCESS_AUD is empty *and* the request is to
 * localhost, the admin is open with a stand-in identity. Anywhere else an
 * empty ACCESS_AUD fails closed.
 */

interface JWK {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface JWTPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  email?: string;
  sub?: string;
}

const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
let keyCache: { fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

export const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const aud = c.env.ACCESS_AUD?.trim() ?? '';
  const team = c.env.ACCESS_TEAM_DOMAIN?.trim() ?? '';

  if (!aud || !team) {
    const host = new URL(c.req.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      c.set('admin', { email: 'dev@localhost' });
      await next();
      return;
    }
    throw errors.forbidden('Admin access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD).');
  }

  const token = c.req.header('cf-access-jwt-assertion') ?? readCookie(c.req.header('cookie'), 'CF_Authorization');
  if (!token) throw errors.unauthorized();

  const payload = await verifyAccessJWT(token, team, aud);
  if (!payload) throw errors.unauthorized();

  c.set('admin', { email: payload.email ?? payload.sub ?? 'unknown' });
  await next();
});

async function verifyAccessJWT(token: string, team: string, aud: string): Promise<JWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: JWTPayload;
  try {
    header = JSON.parse(decodeBase64UrlToString(headerB64));
    payload = JSON.parse(decodeBase64UrlToString(payloadB64));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const key = await publicKey(team, header.kid);
  if (!key) return null;

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    decodeBase64Url(signatureB64),
    data,
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.iss !== `https://${team}`) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;

  return payload;
}

/** Looks up a signing key by kid, refreshing the cached JWKS once on a miss. */
async function publicKey(team: string, kid: string): Promise<CryptoKey | null> {
  const fresh = keyCache && Date.now() - keyCache.fetchedAt < KEY_CACHE_TTL_MS;
  if (fresh && keyCache!.keys.has(kid)) return keyCache!.keys.get(kid)!;

  const response = await fetch(`https://${team}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) return null;
  const body = (await response.json()) as { keys?: JWK[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip malformed keys rather than failing the whole set.
    }
  }
  keyCache = { fetchedAt: Date.now(), keys };
  return keys.get(kid) ?? null;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

function decodeBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeBase64UrlToString(input: string): string {
  return new TextDecoder().decode(decodeBase64Url(input));
}
