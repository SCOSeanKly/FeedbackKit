import { Hono } from 'hono';
import { requireInstallation } from '../auth';
import { sha256Hex } from '../crypto';
import { errors } from '../errors';
import { clientIP, enforceLimit } from '../ratelimit';
import { parseSubmission, readJSONObject } from '../validation';
import { linkAttachments, parseAttachmentIDs } from './attachments';
import type { AppContext } from '../env';

interface ExistingRow {
  id: string;
  state: string;
  installation_id: string;
  payload_hash: string;
}

/** Serialized diagnostics cap. Plenty for versions, locale and a few counters. */
const DIAGNOSTICS_MAX_BYTES = 16 * 1024;
const DIAGNOSTICS_MAX_DEPTH = 4;

/**
 * Validates the optional `diagnostics` object: a JSON object, shallow,
 * at most 16 KiB serialized. Returns canonical JSON text or null.
 */
function parseDiagnostics(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw errors.badRequest('invalid_diagnostics', 'diagnostics must be a JSON object.');
  }
  const depthOK = (node: unknown, depth: number): boolean => {
    if (node === null || typeof node !== 'object') return true;
    if (depth >= DIAGNOSTICS_MAX_DEPTH) return false;
    return Object.values(node as Record<string, unknown>).every((child) => depthOK(child, depth + 1));
  };
  if (!depthOK(value, 0)) throw errors.badRequest('invalid_diagnostics', 'diagnostics is nested too deeply.');
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > DIAGNOSTICS_MAX_BYTES) {
    throw errors.badRequest('invalid_diagnostics', 'diagnostics must be 16 KiB or smaller.');
  }
  return text;
}

/**
 * POST /api/submit  { requestId, kind, title, body, diagnostics? } -> { id, state: "pending" }
 *
 * Idempotent on `requestId`:
 *   • unseen id            -> insert, 201
 *   • same id, same content, same installation -> return the original, 200
 *   • same id, anything else                   -> 409
 *
 * Diagnostics are not part of the content hash: they describe the device
 * at send time and a retry after an update may legitimately differ.
 */
export const submit = new Hono<AppContext>();

submit.post('/', requireInstallation, async (c) => {
  const installation = c.var.installation;
  await enforceLimit(c.env.SUBMIT_INSTALLATION_LIMIT, installation.id);
  await enforceLimit(c.env.SUBMIT_IP_LIMIT, clientIP(c));

  const raw = await readJSONObject(c);
  const input = parseSubmission(raw);
  const diagnostics = parseDiagnostics(raw['diagnostics']);
  const attachmentIds = parseAttachmentIDs(raw);
  const owner = { installationId: installation.id, uploadedBy: 'user' as const };
  // Validate attachments before inserting so a bad id cannot orphan a report.
  await linkAttachments(c.env.DB, attachmentIds, {}, owner);
  const payloadHash = await sha256Hex(`${input.kind}\n${input.title}\n${input.body}`);
  const id = crypto.randomUUID();

  const result = await c.env.DB.prepare(
    `INSERT INTO submissions (id, app_id, installation_id, request_id, kind, title, body, payload_hash, diagnostics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO NOTHING`,
  )
    .bind(
      id,
      installation.appId,
      installation.id,
      input.requestId,
      input.kind,
      input.title,
      input.body,
      payloadHash,
      diagnostics,
    )
    .run();

  if (result.meta.changes === 1) {
    await linkAttachments(c.env.DB, attachmentIds, { submissionId: id }, owner);
    return c.json({ id, state: 'pending' }, 201);
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, state, installation_id, payload_hash FROM submissions WHERE request_id = ?',
  )
    .bind(input.requestId)
    .first<ExistingRow>();

  if (
    existing &&
    existing.installation_id === installation.id &&
    existing.payload_hash === payloadHash
  ) {
    return c.json({ id: existing.id, state: existing.state }, 200);
  }

  throw errors.conflict('This requestId was already used for a different report.');
});
