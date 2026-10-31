import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireInstallation } from '../auth';
import { errors } from '../errors';
import { enforceLimit } from '../ratelimit';
import type { AppContext } from '../env';

/**
 * Private image attachments.
 *
 *   POST /api/attachments       raw image body (Content-Type image/jpeg|png,
 *                               X-Image-Width / X-Image-Height) -> { attachment }
 *   GET  /api/attachments/:id   the bytes, if this installation uploaded it or
 *                               it hangs off one of this installation's reports
 *
 * Uploads start unlinked; `/api/submit` and `/api/reply` link them by id.
 * The admin has mirror routes in admin.ts. Nothing here is ever public.
 */
export const attachments = new Hono<AppContext>();

export const ATTACHMENT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPerParent: 4,
  contentTypes: ['image/jpeg', 'image/png'] as const,
  maxDimension: 10_000,
} as const;

export interface AttachmentRow {
  id: string;
  installation_id: string | null;
  uploaded_by: 'user' | 'developer';
  submission_id: string | null;
  message_id: string | null;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
}

export interface AttachmentJSON {
  id: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
}

export function attachmentToJSON(row: AttachmentRow): AttachmentJSON {
  return { id: row.id, contentType: row.content_type, bytes: row.bytes, width: row.width, height: row.height };
}

const R2_PREFIX = 'att/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dimension(header: string | undefined): number {
  const value = Number(header ?? '0');
  return Number.isInteger(value) && value > 0 && value <= ATTACHMENT_LIMITS.maxDimension ? value : 0;
}

/** Validates and stores an upload; returns the new row. */
export async function storeUpload(
  c: Context<AppContext>,
  owner: { installationId: string | null; uploadedBy: 'user' | 'developer' },
): Promise<AttachmentRow> {
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(ATTACHMENT_LIMITS.contentTypes as readonly string[]).includes(contentType)) {
    throw errors.badRequest('unsupported_type', 'Attachments must be JPEG or PNG images.');
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw errors.badRequest('empty_upload', 'The upload was empty.');
  if (body.byteLength > ATTACHMENT_LIMITS.maxBytes) {
    throw errors.badRequest('upload_too_large', 'Images must be 5 MB or smaller.');
  }
  // Cheap magic-number check so a renamed file cannot masquerade as an image.
  const head = new Uint8Array(body.slice(0, 8));
  const isJPEG = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPNG = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if ((contentType === 'image/jpeg' && !isJPEG) || (contentType === 'image/png' && !isPNG)) {
    throw errors.badRequest('unsupported_type', 'The upload is not a valid image.');
  }

  const id = crypto.randomUUID();
  const width = dimension(c.req.header('x-image-width'));
  const height = dimension(c.req.header('x-image-height'));

  await c.env.ATTACHMENTS.put(R2_PREFIX + id, body, { httpMetadata: { contentType } });
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, installation_id, uploaded_by, content_type, bytes, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, owner.installationId, owner.uploadedBy, contentType, body.byteLength, width, height)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<AttachmentRow>();
  if (!row) throw new Error('Attachment vanished after insert');
  return row;
}

/** Streams an attachment's bytes from R2. */
export async function streamAttachment(c: Context<AppContext>, row: AttachmentRow): Promise<Response> {
  const object = await c.env.ATTACHMENTS.get(R2_PREFIX + row.id);
  if (!object) throw errors.notFound('unknown_attachment', 'That image is no longer available.');
  const headers = new Headers();
  headers.set('Content-Type', row.content_type);
  headers.set('Content-Length', String(row.bytes));
  headers.set('Cache-Control', 'private, max-age=86400, immutable');
  headers.set('Content-Disposition', 'inline');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

/** Optional `attachmentIds`: up to four UUIDs. */
export function parseAttachmentIDs(obj: Record<string, unknown>): string[] {
  const value = obj['attachmentIds'];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.maxPerParent) {
    throw errors.badRequest('invalid_attachments', `attachmentIds must be a list of at most ${ATTACHMENT_LIMITS.maxPerParent} ids.`);
  }
  const ids = value.map((v) => (typeof v === 'string' ? v.toLowerCase() : ''));
  if (ids.some((id) => !UUID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw errors.badRequest('invalid_attachments', 'attachmentIds must be distinct UUIDs.');
  }
  return ids;
}

/**
 * Attaches uploaded images to a message or report. Every id must exist,
 * be unlinked, and belong to the caller (the uploading installation, or the
 * developer for admin uploads); otherwise nothing is linked and it is a 400.
 */
export async function linkAttachments(
  db: D1Database,
  ids: string[],
  parent: { messageId?: string; submissionId?: string },
  owner: { installationId: string | null; uploadedBy: 'user' | 'developer' },
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<AttachmentRow>();
  const byID = new Map(results.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byID.get(id);
    const owned = row && row.uploaded_by === owner.uploadedBy && row.installation_id === owner.installationId;
    if (!row || !owned || row.message_id || row.submission_id) {
      throw errors.badRequest('invalid_attachments', 'One of the attachments is missing, already used, or not yours.');
    }
  }
  await db
    .prepare(
      `UPDATE attachments SET message_id = COALESCE(?1, message_id), submission_id = COALESCE(?2, submission_id)
       WHERE id IN (${placeholders}) AND message_id IS NULL AND submission_id IS NULL`,
    )
    .bind(parent.messageId ?? null, parent.submissionId ?? null, ...ids)
    .run();
}

/** Attachments grouped by parent id, for decorating lists of messages or reports. */
export async function attachmentsByParent(
  db: D1Database,
  column: 'message_id' | 'submission_id',
  parentIDs: string[],
): Promise<Map<string, AttachmentJSON[]>> {
  const map = new Map<string, AttachmentJSON[]>();
  if (parentIDs.length === 0) return map;
  const placeholders = parentIDs.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT * FROM attachments WHERE ${column} IN (${placeholders}) ORDER BY created_at ASC`)
    .bind(...parentIDs)
    .all<AttachmentRow>();
  for (const row of results) {
    const key = row[column];
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(attachmentToJSON(row));
    map.set(key, list);
  }
  return map;
}

/**
 * Deletes every attachment hanging off a submission, directly or via its
 * messages: the R2 objects first, then the rows. Returns how many went.
 */
export async function deleteAttachmentsForSubmission(env: AppContext['Bindings'], submissionId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM attachments
     WHERE submission_id = ?1
        OR message_id IN (SELECT id FROM messages WHERE submission_id = ?1)`,
  )
    .bind(submissionId)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  await env.ATTACHMENTS.delete(results.map((r) => R2_PREFIX + r.id));
  const placeholders = results.map(() => '?').join(', ');
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
    .bind(...results.map((r) => r.id))
    .run();
  return results.length;
}

/** Deletes uploads that were never linked and are older than a day. */
export async function sweepOrphans(env: AppContext['Bindings']): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM attachments
     WHERE message_id IS NULL AND submission_id IS NULL
       AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')
     LIMIT 200`,
  ).all<{ id: string }>();
  if (results.length === 0) return 0;
  await env.ATTACHMENTS.delete(results.map((r) => R2_PREFIX + r.id));
  const placeholders = results.map(() => '?').join(', ');
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
    .bind(...results.map((r) => r.id))
    .run();
  return results.length;
}

attachments.post('/', requireInstallation, async (c) => {
  const installation = c.var.installation;
  await enforceLimit(c.env.UPLOAD_INSTALLATION_LIMIT, installation.id);
  const row = await storeUpload(c, { installationId: installation.id, uploadedBy: 'user' });
  return c.json({ attachment: attachmentToJSON(row) }, 201);
});

attachments.get('/:id', requireInstallation, async (c) => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID_PATTERN.test(id)) throw errors.notFound('unknown_attachment', 'That image is no longer available.');
  // Own uploads, plus anything attached to one of this installation's reports
  // (so developer-sent images are readable by the person they were sent to).
  const row = await c.env.DB.prepare(
    `SELECT a.* FROM attachments a
     LEFT JOIN messages m ON m.id = a.message_id
     LEFT JOIN submissions s ON s.id = COALESCE(a.submission_id, m.submission_id)
     WHERE a.id = ?1 AND (a.installation_id = ?2 OR s.installation_id = ?2)`,
  )
    .bind(id, c.var.installation.id)
    .first<AttachmentRow>();
  if (!row) throw errors.notFound('unknown_attachment', 'That image is no longer available.');
  return streamAttachment(c, row);
});
