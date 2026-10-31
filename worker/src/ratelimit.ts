import type { Context } from 'hono';
import { errors } from './errors';
import type { RateLimiter } from './env';

/** All limiters in wrangler.toml use a 60 s window; this is what Retry-After reports. */
const WINDOW_SECONDS = 60;

/** The caller's IP as seen by Cloudflare. Falls back to one shared bucket in local dev. */
export function clientIP(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'local';
}

/** Throws a 429 with Retry-After when `key` has exhausted `limiter`. */
export async function enforceLimit(limiter: RateLimiter, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw errors.rateLimited(WINDOW_SECONDS);
}
