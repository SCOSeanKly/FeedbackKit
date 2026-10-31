import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireInstallation } from '../auth';
import { errors } from '../errors';
import { enforceLimit } from '../ratelimit';
import { optionalNonNegativeInt, parseMessage, readJSONObject, requireString, requireUUID } from '../validation';
import { attachmentsByParent, linkAttachments, parseAttachmentIDs, type AttachmentJSON } from './attachments';
import type { AppContext } from '../env';

/**
 * Private two-way conversation between a reporter and the developer about
 * one submission. Only the installation that sent the report can see it.
 *
 *   POST /api/conversation       { submissionId, after }        -> { messages, hasMore, nextAfter }
 *   POST /api/reply              { submissionId, requestId, message, attachmentIds? } -> { message }
 *   POST /api/conversation-read  { submissionId, through }      -> { readThrough }
 *   POST /api/unread                                             -> { unread }
 *
 * Messages are ordered by a per-submission `seq`; clients page with `after`
 * (the last seq they have). Replies are idempotent on `requestId`. Each
 * message carries its image attachments (see attachments.ts).
 */
export const conversation = new Hono<AppContext>();

const PAGE_SIZE = 50;

export interface MessageRow {
  id: string;
  submission_id: string;
  sender: 'user' | 'developer';
  body: string;
  seq: number;
  request_id: string;
  created_at: string;
}

export function messageToJSON(row: MessageRow, attachments: AttachmentJSON[] = []) {
  return { id: row.id, sender: row.sender, body: row.body, seq: row.seq, createdAt: row.created_at, attachments };
}

/** The caller's own submission, or 404 (existence of others' reports is not revealed). */
async function ownSubmission(c: Context<AppContext>, id: string) {
  const row = await c.env.DB.prepare('SELECT id, installation_id, state FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ id: string; installation_id: string; state: string }>();
  if (!row || row.installation_id !== c.var.installation.id) {
    throw errors.notFound('unknown_submission', 'No report with that id.');
  }
  return row;
}

/**
 * Appends a message with the next seq. Idempotent on requestId: an identical
 * retry returns the stored message; a different body under the same id is 409.
 * A message may be text-only, images-only, or both.
 */
export async function appendMessage(
  db: D1Database,
  submissionId: string,
  sender: 'user' | 'developer',
  body: string,
  requestId: string,
): Promise<{ message: MessageRow; created: boolean }> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO messages (id, submission_id, sender, body, seq, request_id)
       SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(seq), 0) + 1, ?5 FROM messages WHERE submission_id = ?2
       ON CONFLICT(request_id) DO NOTHING`,
    )
    .bind(id, submissionId, sender, body, requestId)
    .run();

  const stored = await db
    .prepare('SELECT id, submission_id, sender, body, seq, request_id, created_at FROM messages WHERE request_id = ?')
    .bind(requestId)
    .first<MessageRow>();
  if (!stored) throw new Error('Message vanished after insert');

  if (result.meta.changes === 1) return { message: stored, created: true };
  if (stored.submission_id === submissionId && stored.sender === sender && stored.body === body) {
    return { message: stored, created: false };
  }
  throw errors.conflict('This requestId was already used for a different message.');
}

/** Advances a side's read marker, never moving it backwards. */
export async function markRead(
  db: D1Database,
  submissionId: string,
  side: 'user' | 'developer',
  through: number,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO conversation_reads (submission_id, side, read_through)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(submission_id, side) DO UPDATE SET
         read_through = MAX(read_through, excluded.read_through),
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(submissionId, side, through)
    .run();
  const row = await db
    .prepare('SELECT read_through FROM conversation_reads WHERE submission_id = ? AND side = ?')
    .bind(submissionId, side)
    .first<{ read_through: number }>();
  return row?.read_through ?? through;
}

/** Message text may be empty only when images are attached. */
function parseOptionalMessage(input: Record<string, unknown>, attachmentCount: number): string {
  const raw = input['message'];
  if ((raw === undefined || raw === null || raw === '') && attachmentCount > 0) return '';
  return parseMessage(input);
}

conversation.post('/conversation', requireInstallation, async (c) => {
  const input = await readJSONObject(c);
  const submission = await ownSubmission(c, requireString(input, 'submissionId'));
  const after = optionalNonNegativeInt(input, 'after');

  const { results } = await c.env.DB.prepare(
    `SELECT id, submission_id, sender, body, seq, request_id, created_at FROM messages
     WHERE submission_id = ? AND seq > ?
     ORDER BY seq ASC LIMIT ?`,
  )
    .bind(submission.id, after, PAGE_SIZE + 1)
    .all<MessageRow>();

  const page = results.slice(0, PAGE_SIZE);
  const attachments = await attachmentsByParent(c.env.DB, 'message_id', page.map((m) => m.id));
  return c.json({
    messages: page.map((m) => messageToJSON(m, attachments.get(m.id) ?? [])),
    hasMore: results.length > PAGE_SIZE,
    nextAfter: page.length > 0 ? page[page.length - 1]!.seq : after,
  });
});

conversation.post('/reply', requireInstallation, async (c) => {
  const installation = c.var.installation;
  await enforceLimit(c.env.REPLY_INSTALLATION_LIMIT, installation.id);

  const input = await readJSONObject(c);
  const submission = await ownSubmission(c, requireString(input, 'submissionId'));
  const requestId = requireUUID(input, 'requestId');
  const attachmentIds = parseAttachmentIDs(input);
  const body = parseOptionalMessage(input, attachmentIds.length);
  const owner = { installationId: installation.id, uploadedBy: 'user' as const };

  // Validate the attachments before the message exists, so a bad id cannot
  // leave a half-made message behind.
  await linkAttachments(c.env.DB, attachmentIds, {}, owner);

  const { message, created } = await appendMessage(c.env.DB, submission.id, 'user', body, requestId);
  if (created) await linkAttachments(c.env.DB, attachmentIds, { messageId: message.id }, owner);
  // Sending implies having read everything before it.
  await markRead(c.env.DB, submission.id, 'user', message.seq);

  const attachments = await attachmentsByParent(c.env.DB, 'message_id', [message.id]);
  return c.json({ message: messageToJSON(message, attachments.get(message.id) ?? []) }, created ? 201 : 200);
});

/**
 * POST /api/unread -> { unread }
 *
 * Developer messages this installation has not read yet, across all of its
 * reports. Cheap enough to call on every foreground; drives app badges.
 */
conversation.post('/unread', requireInstallation, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m
     JOIN submissions s ON s.id = m.submission_id
     WHERE s.installation_id = ?1 AND m.sender = 'developer'
       AND m.seq > COALESCE((SELECT r.read_through FROM conversation_reads r
                              WHERE r.submission_id = s.id AND r.side = 'user'), 0)`,
  )
    .bind(c.var.installation.id)
    .first<{ n: number }>();
  c.header('Cache-Control', 'no-store');
  return c.json({ unread: row?.n ?? 0 });
});

conversation.post('/conversation-read', requireInstallation, async (c) => {
  const input = await readJSONObject(c);
  const submission = await ownSubmission(c, requireString(input, 'submissionId'));
  const through = optionalNonNegativeInt(input, 'through');
  const readThrough = await markRead(c.env.DB, submission.id, 'user', through);
  return c.json({ readThrough });
});
