import type { Context } from 'hono';
import { errors } from './errors';

export const KINDS = ['issue', 'idea', 'other'] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Length limits, counted in Unicode scalars. The Swift client counts
 * `unicodeScalars` so both sides agree exactly, including on emoji.
 */
export const LIMITS = {
  title: { min: 5, max: 160 },
  body: { min: 10, max: 10_000 },
  message: { min: 1, max: 4_000 },
  appId: { max: 64 },
} as const;

export interface SubmissionInput {
  requestId: string;
  kind: Kind;
  title: string;
  body: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of Unicode scalars in `s` (not UTF-16 units). */
export function scalarLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Parses the request body as a JSON object, or throws 400. */
export async function readJSONObject(c: Context): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw errors.badRequest('invalid_json', 'Request body must be a JSON object.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.badRequest('invalid_json', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw errors.badRequest('invalid_field', `Field "${key}" must be a string.`);
  }
  return value;
}

export function optionalNonNegativeInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw errors.badRequest('invalid_field', `Field "${key}" must be a non-negative integer.`);
  }
  return value;
}

export function requireUUID(obj: Record<string, unknown>, key: string): string {
  const value = requireString(obj, key).toLowerCase();
  if (!UUID_PATTERN.test(value)) {
    throw errors.badRequest('invalid_field', `Field "${key}" must be a UUID.`);
  }
  return value;
}

export function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw errors.badRequest('invalid_field', `Field "${key}" must be true or false.`);
  }
  return value;
}

export function requirePositiveInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw errors.badRequest('invalid_field', `Field "${key}" must be a positive integer.`);
  }
  return value;
}

/** A conversation message: trimmed, line endings normalised, 1–4,000 scalars. */
export function parseMessage(obj: Record<string, unknown>, key = 'message'): string {
  const message = requireString(obj, key).replace(/\r\n?/g, '\n').trim();
  const length = scalarLength(message);
  if (length < LIMITS.message.min || length > LIMITS.message.max) {
    throw errors.badRequest(
      'invalid_message',
      `${key} must be ${LIMITS.message.min}–${LIMITS.message.max} characters.`,
    );
  }
  return message;
}

/** Validates and normalises a `/api/submit` body. Throws 400 on any problem. */
export function parseSubmission(obj: Record<string, unknown>): SubmissionInput {
  const requestId = requireString(obj, 'requestId').toLowerCase();
  if (!UUID_PATTERN.test(requestId)) {
    throw errors.badRequest('invalid_request_id', 'requestId must be a UUID.');
  }

  const kind = requireString(obj, 'kind');
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw errors.badRequest('invalid_kind', `kind must be one of ${KINDS.join(', ')}.`);
  }

  // Titles are a single line; bodies keep their line breaks (normalised to \n).
  const title = requireString(obj, 'title').replace(/\s+/g, ' ').trim();
  const body = requireString(obj, 'body').replace(/\r\n?/g, '\n').trim();

  const titleLength = scalarLength(title);
  if (titleLength < LIMITS.title.min || titleLength > LIMITS.title.max) {
    throw errors.badRequest(
      'invalid_title',
      `title must be ${LIMITS.title.min}–${LIMITS.title.max} characters.`,
    );
  }
  const bodyLength = scalarLength(body);
  if (bodyLength < LIMITS.body.min || bodyLength > LIMITS.body.max) {
    throw errors.badRequest(
      'invalid_body',
      `body must be ${LIMITS.body.min}–${LIMITS.body.max} characters.`,
    );
  }

  return { requestId, kind: kind as Kind, title, body };
}
