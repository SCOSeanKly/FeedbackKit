import { Hono } from 'hono';
import { requireInstallation } from '../auth';
import { optionalNonNegativeInt, readJSONObject } from '../validation';
import type { AppContext } from '../env';

const PAGE_SIZE = 50;

interface SubmissionRow {
  id: string;
  request_id: string;
  kind: string;
  title: string;
  body: string;
  state: string;
  created_at: string;
  issue_number: number | null;
  issue_status: string | null;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
}

/**
 * POST /api/mine  { offset } -> { submissions: [...], hasMore }
 *
 * This installation's own submissions, newest first, 50 per page. The raw
 * title and body are returned here because they belong to the person who
 * wrote them; this is the only place raw text leaves the server.
 *
 * Each row also carries the linked public issue (number and status, once
 * published) and conversation counters so the app can show badges.
 */
export const mine = new Hono<AppContext>();

mine.post('/', requireInstallation, async (c) => {
  const installation = c.var.installation;
  const offset = optionalNonNegativeInt(await readJSONObject(c), 'offset');

  // Fetch one extra row to learn whether another page exists.
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.request_id, s.kind, s.title, s.body, s.state, s.created_at,
            (SELECT i.number FROM submission_issue_links l JOIN issues i ON i.id = l.issue_id
               WHERE l.submission_id = s.id ORDER BY i.number LIMIT 1) AS issue_number,
            (SELECT i.status FROM submission_issue_links l JOIN issues i ON i.id = l.issue_id
               WHERE l.submission_id = s.id ORDER BY i.number LIMIT 1) AS issue_status,
            (SELECT COUNT(*) FROM messages m WHERE m.submission_id = s.id) AS message_count,
            (SELECT COUNT(*) FROM messages m WHERE m.submission_id = s.id AND m.sender = 'developer'
               AND m.seq > COALESCE((SELECT r.read_through FROM conversation_reads r
                                      WHERE r.submission_id = s.id AND r.side = 'user'), 0)) AS unread_count,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.submission_id = s.id) AS last_message_at
     FROM submissions s
     WHERE s.installation_id = ?
     ORDER BY s.created_at DESC, s.rowid DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(installation.id, PAGE_SIZE + 1, offset)
    .all<SubmissionRow>();

  const page = results.slice(0, PAGE_SIZE);
  return c.json({
    submissions: page.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      state: row.state,
      createdAt: row.created_at,
      issue: row.issue_number !== null ? { number: row.issue_number, status: row.issue_status } : null,
      messageCount: row.message_count,
      unreadCount: row.unread_count,
      lastMessageAt: row.last_message_at,
    })),
    hasMore: results.length > PAGE_SIZE,
  });
});
