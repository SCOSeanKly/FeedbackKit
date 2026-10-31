import { Hono } from 'hono';
import { requireAdmin } from '../access';
import { ADMIN_HTML } from '../admin-ui';
import { errors } from '../errors';
import {
  ISSUE_COLUMNS,
  ISSUE_LIMITS,
  NOW_SQL,
  ROADMAP_LANES,
  isIssueStatus,
  issueToJSON,
  likePattern,
  type IssueRow,
  type IssueStatus,
  type RoadmapLane,
} from '../issues';
import { KINDS, optionalNonNegativeInt, parseMessage, readJSONObject, requirePositiveInt, scalarLength } from '../validation';
import {
  attachmentToJSON,
  attachmentsByParent,
  deleteAttachmentsForSubmission,
  linkAttachments,
  parseAttachmentIDs,
  storeUpload,
  streamAttachment,
  type AttachmentRow,
} from './attachments';
import { appendMessage, markRead, messageToJSON, type MessageRow } from './conversation';
import type { AppContext } from '../env';

/**
 * Developer-only API and page, all behind Cloudflare Access (see access.ts).
 *
 *   GET   /admin                                the inbox page
 *   GET   /admin/api/me                         who is signed in
 *   GET   /admin/api/apps                       apps with pending and unread counts
 *   GET   /admin/api/inbox?app&state&kind&q&offset
 *   GET   /admin/api/submissions/:id            submission + private conversation
 *   POST  /admin/api/submissions/:id/publish    { title, body, status?, release?, roadmapLane? } -> issue
 *   POST  /admin/api/submissions/:id/dismiss
 *   POST  /admin/api/submissions/:id/restore    back to pending
 *   DELETE /admin/api/submissions/:id           hard delete (spam): report, conversation, attachments; the issue stays
 *   POST  /admin/api/submissions/:id/reply      { message } -> developer message
 *   POST  /admin/api/submissions/:id/read       { through } -> developer read marker
 *   GET   /admin/api/issues?app&status&q&offset
 *   GET   /admin/api/issues/:id                 issue + reports behind it + merged-in issues
 *   PATCH /admin/api/issues/:id                 { title, body, status, release, roadmapLane?, version }; status changes append to issue_status_history
 *   POST  /admin/api/issues/:id/merge           { intoNumber } -> this issue becomes a pointer to the other
 *
 * Issue edits carry the row's `version`; a stale version is a 409 so two
 * browser tabs cannot silently overwrite each other.
 */
export const admin = new Hono<AppContext>();

admin.use('*', requireAdmin);

const PAGE_SIZE = 50;
const SUBMISSION_STATES = ['pending', 'published', 'dismissed'] as const;

interface SubmissionRow {
  id: string;
  app_id: string;
  installation_id: string;
  kind: string;
  title: string;
  body: string;
  state: string;
  created_at: string;
  issue_id: string | null;
  issue_number: number | null;
  message_count: number;
  unread: number;
  last_message_at: string | null;
  diagnostics: string | null;
  attested: number;
}

const SUBMISSION_SELECT = `
  SELECT s.id, s.app_id, s.installation_id, s.kind, s.title, s.body, s.state, s.created_at, s.diagnostics,
         (SELECT inst.attested FROM installations inst WHERE inst.id = s.installation_id) AS attested,
         (SELECT i.id FROM submission_issue_links l JOIN issues i ON i.id = l.issue_id
            WHERE l.submission_id = s.id ORDER BY i.number LIMIT 1) AS issue_id,
         (SELECT i.number FROM submission_issue_links l JOIN issues i ON i.id = l.issue_id
            WHERE l.submission_id = s.id ORDER BY i.number LIMIT 1) AS issue_number,
         (SELECT COUNT(*) FROM messages m WHERE m.submission_id = s.id) AS message_count,
         (SELECT COUNT(*) FROM messages m WHERE m.submission_id = s.id AND m.sender = 'user'
            AND m.seq > COALESCE((SELECT r.read_through FROM conversation_reads r
                                   WHERE r.submission_id = s.id AND r.side = 'developer'), 0)) AS unread,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.submission_id = s.id) AS last_message_at
  FROM submissions s`;

function submissionToJSON(row: SubmissionRow) {
  return {
    id: row.id,
    appId: row.app_id,
    installationId: row.installation_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    state: row.state,
    createdAt: row.created_at,
    issue: row.issue_id && row.issue_number !== null ? { id: row.issue_id, number: row.issue_number } : null,
    messageCount: row.message_count,
    unread: row.unread,
    lastMessageAt: row.last_message_at,
    attested: row.attested === 1,
    diagnostics: parseStoredJSON(row.diagnostics),
  };
}

function parseStoredJSON(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Issue row plus engagement counts for admin listings. */
interface AdminIssueRow extends IssueRow {
  votes: number;
  follows: number;
}

const ADMIN_ISSUE_SELECT = `
  SELECT ${ISSUE_COLUMNS.split(', ').map((c) => `i.${c}`).join(', ')},
         (SELECT COUNT(*) FROM votes v WHERE v.issue_id = i.id) AS votes,
         (SELECT COUNT(*) FROM follows f WHERE f.issue_id = i.id) AS follows
  FROM issues i`;

function adminIssueToJSON(row: AdminIssueRow) {
  return { ...issueToJSON(row), votes: row.votes, follows: row.follows };
}

function pageParams(url: URL) {
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  return {
    q: (url.searchParams.get('q') ?? '').trim().slice(0, 100),
    offset: Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
  };
}

function requireApp(url: URL): string {
  const app = (url.searchParams.get('app') ?? '').trim();
  if (!app) throw errors.badRequest('missing_app', 'Query parameter "app" is required.');
  return app;
}

/** Validates editable issue fields shared by publish and edit. */
function parseIssueFields(obj: Record<string, unknown>) {
  const titleRaw = obj['title'];
  if (typeof titleRaw !== 'string') throw errors.badRequest('invalid_field', 'title must be a string.');
  const title = titleRaw.replace(/\s+/g, ' ').trim();
  const titleLength = scalarLength(title);
  if (titleLength < ISSUE_LIMITS.title.min || titleLength > ISSUE_LIMITS.title.max) {
    throw errors.badRequest(
      'invalid_title',
      `title must be ${ISSUE_LIMITS.title.min}–${ISSUE_LIMITS.title.max} characters.`,
    );
  }

  const bodyRaw = obj['body'] ?? '';
  if (typeof bodyRaw !== 'string') throw errors.badRequest('invalid_field', 'body must be a string.');
  const body = bodyRaw.replace(/\r\n?/g, '\n').trim();
  if (scalarLength(body) > ISSUE_LIMITS.body.max) {
    throw errors.badRequest('invalid_body', `body must be at most ${ISSUE_LIMITS.body.max} characters.`);
  }

  const statusRaw = obj['status'] ?? 'reported';
  if (!isIssueStatus(statusRaw)) {
    throw errors.badRequest('invalid_status', 'status is not one of the allowed values.');
  }
  const status: IssueStatus = statusRaw;

  const releaseRaw = obj['release'] ?? null;
  if (releaseRaw !== null && typeof releaseRaw !== 'string') {
    throw errors.badRequest('invalid_field', 'release must be a string or null.');
  }
  const releaseTrimmed = (releaseRaw ?? '').trim();
  if (scalarLength(releaseTrimmed) > ISSUE_LIMITS.release.max) {
    throw errors.badRequest('invalid_release', `release must be at most ${ISSUE_LIMITS.release.max} characters.`);
  }
  const release = releaseTrimmed.length > 0 ? releaseTrimmed : null;

  // Roadmap lane is only changed when the key is present; null clears it.
  let roadmapLane: RoadmapLane | null | undefined;
  if ('roadmapLane' in obj) {
    const laneRaw = obj['roadmapLane'];
    if (laneRaw === null || laneRaw === '') roadmapLane = null;
    else if (typeof laneRaw === 'string' && (ROADMAP_LANES as readonly string[]).includes(laneRaw)) {
      roadmapLane = laneRaw as RoadmapLane;
    } else {
      throw errors.badRequest('invalid_lane', 'roadmapLane must be now, next, later or null.');
    }
  }

  return { title, body, status, release, roadmapLane };
}

// MARK: Page and identity

admin.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.html(ADMIN_HTML);
});

admin.get('/api/me', (c) => c.json(c.var.admin));

admin.get('/api/apps', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.bundle_id, a.created_at,
            (SELECT COUNT(*) FROM submissions s WHERE s.app_id = a.id AND s.state = 'pending') AS pending,
            (SELECT COUNT(*) FROM messages m JOIN submissions s ON s.id = m.submission_id
               WHERE s.app_id = a.id AND m.sender = 'user'
                 AND m.seq > COALESCE((SELECT r.read_through FROM conversation_reads r
                                        WHERE r.submission_id = s.id AND r.side = 'developer'), 0)) AS unread
     FROM apps a ORDER BY a.name`,
  ).all<{ id: string; name: string; bundle_id: string; created_at: string; pending: number; unread: number }>();
  // Landing-page enquiries are not per app; the count rides along so the header can show a badge.
  const enquiries = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM enquiries WHERE handled = 0').first<{ n: number }>();
  return c.json({
    apps: results.map((r) => ({
      id: r.id,
      name: r.name,
      bundleId: r.bundle_id,
      createdAt: r.created_at,
      pending: r.pending,
      unread: r.unread,
    })),
    unhandledEnquiries: enquiries?.n ?? 0,
  });
});

// MARK: Inbox

admin.get('/api/inbox', async (c) => {
  const url = new URL(c.req.url);
  const appId = requireApp(url);
  const { q, offset } = pageParams(url);

  const stateParam = url.searchParams.get('state') ?? 'pending';
  const state = stateParam === 'all' ? '' : stateParam;
  if (state && !(SUBMISSION_STATES as readonly string[]).includes(state)) {
    throw errors.badRequest('invalid_state', 'state must be pending, published, dismissed or all.');
  }
  const kind = url.searchParams.get('kind') ?? '';
  if (kind && !(KINDS as readonly string[]).includes(kind)) {
    throw errors.badRequest('invalid_kind', 'kind is not one of the allowed values.');
  }

  const { results } = await c.env.DB.prepare(
    `${SUBMISSION_SELECT}
     WHERE s.app_id = ?1
       AND (?2 = '' OR s.state = ?2)
       AND (?3 = '' OR s.kind = ?3)
       AND (?4 = '' OR s.title LIKE ?5 ESCAPE '\\' OR s.body LIKE ?5 ESCAPE '\\')
     ORDER BY s.created_at DESC, s.rowid DESC
     LIMIT ?6 OFFSET ?7`,
  )
    .bind(appId, state, kind, q, likePattern(q), PAGE_SIZE + 1, offset)
    .all<SubmissionRow>();

  return c.json({
    submissions: results.slice(0, PAGE_SIZE).map(submissionToJSON),
    hasMore: results.length > PAGE_SIZE,
  });
});

async function loadSubmission(db: D1Database, id: string): Promise<SubmissionRow> {
  const row = await db.prepare(`${SUBMISSION_SELECT} WHERE s.id = ?`).bind(id).first<SubmissionRow>();
  if (!row) throw errors.notFound('unknown_submission', 'No submission with that id.');
  return row;
}

admin.get('/api/submissions/:id', async (c) => {
  const row = await loadSubmission(c.env.DB, c.req.param('id'));
  const batch = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, submission_id, sender, body, seq, request_id, created_at FROM messages
       WHERE submission_id = ? ORDER BY seq ASC LIMIT 500`,
    ).bind(row.id),
    c.env.DB.prepare('SELECT side, read_through FROM conversation_reads WHERE submission_id = ?').bind(row.id),
  ]);
  const messages = (batch[0]?.results ?? []) as MessageRow[];
  const reads = (batch[1]?.results ?? []) as { side: 'user' | 'developer'; read_through: number }[];
  const readThrough = { user: 0, developer: 0 };
  for (const r of reads) readThrough[r.side] = r.read_through;

  const messageAttachments = await attachmentsByParent(c.env.DB, 'message_id', messages.map((m) => m.id));
  const submissionAttachments = await attachmentsByParent(c.env.DB, 'submission_id', [row.id]);
  return c.json({
    submission: { ...submissionToJSON(row), attachments: submissionAttachments.get(row.id) ?? [] },
    messages: messages.map((m) => messageToJSON(m, messageAttachments.get(m.id) ?? [])),
    readThrough,
  });
});

// MARK: Attachments (developer side)

admin.post('/api/attachments', async (c) => {
  const row = await storeUpload(c, { installationId: null, uploadedBy: 'developer' });
  return c.json({ attachment: attachmentToJSON(row) }, 201);
});

admin.get('/api/attachments/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?')
    .bind(c.req.param('id').toLowerCase())
    .first<AttachmentRow>();
  if (!row) throw errors.notFound('unknown_attachment', 'That image is no longer available.');
  return streamAttachment(c, row);
});

admin.post('/api/submissions/:id/publish', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  if (submission.state === 'published') {
    throw errors.conflict('This submission has already been published.', 'already_published');
  }
  const fields = parseIssueFields(await readJSONObject(c));
  const issueId = crypto.randomUUID();

  // One transaction: allocate the next per-app number, link, flip state.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO issues (id, app_id, number, title, body, status, "release", roadmap_lane)
       SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6, ?7 FROM issues WHERE app_id = ?2`,
    ).bind(issueId, submission.app_id, fields.title, fields.body, fields.status, fields.release, fields.roadmapLane ?? null),
    c.env.DB.prepare('INSERT INTO submission_issue_links (submission_id, issue_id) VALUES (?, ?)').bind(
      submission.id,
      issueId,
    ),
    c.env.DB.prepare("UPDATE submissions SET state = 'published' WHERE id = ?").bind(submission.id),
    // First point on the public timeline.
    c.env.DB.prepare('INSERT INTO issue_status_history (issue_id, status) VALUES (?, ?)').bind(issueId, fields.status),
  ]);

  const issue = await c.env.DB.prepare(`${ADMIN_ISSUE_SELECT} WHERE i.id = ?`).bind(issueId).first<AdminIssueRow>();
  if (!issue) throw new Error('Issue vanished after insert');
  return c.json({ issue: adminIssueToJSON(issue) }, 201);
});

admin.post('/api/submissions/:id/dismiss', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  if (submission.state === 'published') {
    throw errors.conflict('Published submissions cannot be dismissed; edit or close the issue instead.', 'already_published');
  }
  await c.env.DB.prepare("UPDATE submissions SET state = 'dismissed' WHERE id = ?").bind(submission.id).run();
  return c.json({ submission: submissionToJSON({ ...submission, state: 'dismissed' }) });
});

admin.post('/api/submissions/:id/restore', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  if (submission.state !== 'dismissed') {
    throw errors.conflict('Only dismissed submissions can be restored.', 'not_dismissed');
  }
  await c.env.DB.prepare("UPDATE submissions SET state = 'pending' WHERE id = ?").bind(submission.id).run();
  return c.json({ submission: submissionToJSON({ ...submission, state: 'pending' }) });
});

/**
 * Hard delete for spam and abuse. Removes the report, its private
 * conversation, read markers, issue links and every attachment (R2 bytes
 * included). A public issue the report was linked to is left alone: it is
 * the developer's own copy. The reporter simply stops seeing the report.
 */
admin.delete('/api/submissions/:id', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  const attachments = await deleteAttachmentsForSubmission(c.env, submission.id);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE submission_id = ?').bind(submission.id),
    c.env.DB.prepare('DELETE FROM conversation_reads WHERE submission_id = ?').bind(submission.id),
    c.env.DB.prepare('DELETE FROM submission_issue_links WHERE submission_id = ?').bind(submission.id),
    c.env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(submission.id),
  ]);
  return c.json({ deleted: true, id: submission.id, attachments });
});

admin.post('/api/submissions/:id/reply', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  const input = await readJSONObject(c);
  const attachmentIds = parseAttachmentIDs(input);
  const raw = input['message'];
  const body = (raw === undefined || raw === null || raw === '') && attachmentIds.length > 0 ? '' : parseMessage(input);
  const owner = { installationId: null, uploadedBy: 'developer' as const };

  await linkAttachments(c.env.DB, attachmentIds, {}, owner);
  const { message } = await appendMessage(c.env.DB, submission.id, 'developer', body, crypto.randomUUID());
  await linkAttachments(c.env.DB, attachmentIds, { messageId: message.id }, owner);
  await markRead(c.env.DB, submission.id, 'developer', message.seq);

  const attachments = await attachmentsByParent(c.env.DB, 'message_id', [message.id]);
  return c.json({ message: messageToJSON(message, attachments.get(message.id) ?? []) }, 201);
});

admin.post('/api/submissions/:id/read', async (c) => {
  const submission = await loadSubmission(c.env.DB, c.req.param('id'));
  const through = optionalNonNegativeInt(await readJSONObject(c), 'through');
  const readThrough = await markRead(c.env.DB, submission.id, 'developer', through);
  return c.json({ readThrough });
});

// MARK: Issues

admin.get('/api/issues', async (c) => {
  const url = new URL(c.req.url);
  const appId = requireApp(url);
  const { q, offset } = pageParams(url);
  const status = url.searchParams.get('status') ?? '';
  if (status && !isIssueStatus(status)) {
    throw errors.badRequest('invalid_status', 'status is not one of the allowed values.');
  }

  const { results } = await c.env.DB.prepare(
    `${ADMIN_ISSUE_SELECT}
     WHERE i.app_id = ?1
       AND (?2 = '' OR i.status = ?2)
       AND (?3 = '' OR i.title LIKE ?4 ESCAPE '\\')
     ORDER BY i.updated_at DESC, i.number DESC
     LIMIT ?5 OFFSET ?6`,
  )
    .bind(appId, status, q, likePattern(q), PAGE_SIZE + 1, offset)
    .all<AdminIssueRow>();

  return c.json({
    issues: results.slice(0, PAGE_SIZE).map(adminIssueToJSON),
    hasMore: results.length > PAGE_SIZE,
  });
});

async function loadIssue(db: D1Database, id: string): Promise<AdminIssueRow> {
  const issue = await db.prepare(`${ADMIN_ISSUE_SELECT} WHERE i.id = ?`).bind(id).first<AdminIssueRow>();
  if (!issue) throw errors.notFound('unknown_issue', 'No issue with that id.');
  return issue;
}

admin.get('/api/issues/:id', async (c) => {
  const issue = await loadIssue(c.env.DB, c.req.param('id'));

  const batch = await c.env.DB.batch([
    c.env.DB.prepare(
      `${SUBMISSION_SELECT}
       JOIN submission_issue_links l ON l.submission_id = s.id
       WHERE l.issue_id = ?
       ORDER BY s.created_at DESC`,
    ).bind(issue.id),
    c.env.DB.prepare('SELECT id, number, title FROM issues WHERE merged_into = ? ORDER BY number').bind(issue.id),
    c.env.DB.prepare('SELECT number FROM issues WHERE id = ?').bind(issue.merged_into ?? ''),
  ]);
  const submissions = (batch[0]?.results ?? []) as SubmissionRow[];
  const mergedIssues = (batch[1]?.results ?? []) as { id: string; number: number; title: string }[];
  const target = (batch[2]?.results ?? [])[0] as { number: number } | undefined;

  return c.json({
    issue: adminIssueToJSON(issue),
    mergedIntoNumber: target?.number ?? null,
    mergedIssues,
    submissions: submissions.map(submissionToJSON),
  });
});

admin.patch('/api/issues/:id', async (c) => {
  const id = c.req.param('id');
  const input = await readJSONObject(c);
  const version = input['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw errors.badRequest('invalid_version', 'version must be an integer.');
  }
  const fields = parseIssueFields(input);
  const setLane = fields.roadmapLane !== undefined ? 1 : 0;

  // The history row is written first, inside the same transaction, and only
  // when the status really changes on a row whose version still matches.
  const batch = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO issue_status_history (issue_id, status)
       SELECT ?1, ?2 FROM issues WHERE id = ?1 AND version = ?3 AND status <> ?2`,
    ).bind(id, fields.status, version),
    c.env.DB.prepare(
      `UPDATE issues
       SET title = ?1, body = ?2, status = ?3, "release" = ?4,
           roadmap_lane = CASE WHEN ?5 = 1 THEN ?6 ELSE roadmap_lane END,
           updated_at = ${NOW_SQL}, version = version + 1
       WHERE id = ?7 AND version = ?8`,
    ).bind(fields.title, fields.body, fields.status, fields.release, setLane, fields.roadmapLane ?? null, id, version),
  ]);
  const result = batch[1];
  if (!result) throw new Error('Issue update batch returned fewer results than expected');

  const issue = await loadIssue(c.env.DB, id);
  if (result.meta.changes === 0) {
    throw new VersionConflict(adminIssueToJSON(issue));
  }
  return c.json({ issue: adminIssueToJSON(issue) });
});

/**
 * Merges this issue into another in the same app. Reports, votes and follows
 * move to the retained issue (duplicates collapse), any issues already
 * pointing at this one are re-pointed, and this number becomes a redirect.
 */
admin.post('/api/issues/:id/merge', async (c) => {
  const source = await loadIssue(c.env.DB, c.req.param('id'));
  const intoNumber = requirePositiveInt(await readJSONObject(c), 'intoNumber');

  if (source.merged_into) throw errors.conflict('This issue is already merged.', 'already_merged');
  const target = await c.env.DB.prepare(`${ADMIN_ISSUE_SELECT} WHERE i.app_id = ? AND i.number = ?`)
    .bind(source.app_id, intoNumber)
    .first<AdminIssueRow>();
  if (!target) throw errors.notFound('unknown_issue', `No issue #${intoNumber} in this app.`);
  if (target.id === source.id) throw errors.badRequest('merge_self', 'An issue cannot be merged into itself.');
  if (target.merged_into) throw errors.conflict('The target issue is itself merged; pick the retained one.', 'target_merged');

  const db = c.env.DB;
  await db.batch([
    db.prepare(`UPDATE issues SET merged_into = ?1, updated_at = ${NOW_SQL}, version = version + 1 WHERE id = ?2`).bind(target.id, source.id),
    db.prepare('UPDATE issues SET merged_into = ?1 WHERE merged_into = ?2').bind(target.id, source.id),
    db.prepare(
      'INSERT OR IGNORE INTO submission_issue_links (submission_id, issue_id) SELECT submission_id, ?1 FROM submission_issue_links WHERE issue_id = ?2',
    ).bind(target.id, source.id),
    db.prepare('DELETE FROM submission_issue_links WHERE issue_id = ?').bind(source.id),
    db.prepare('INSERT OR IGNORE INTO votes (issue_id, installation_id) SELECT ?1, installation_id FROM votes WHERE issue_id = ?2').bind(target.id, source.id),
    db.prepare('DELETE FROM votes WHERE issue_id = ?').bind(source.id),
    db.prepare('INSERT OR IGNORE INTO follows (issue_id, installation_id) SELECT ?1, installation_id FROM follows WHERE issue_id = ?2').bind(target.id, source.id),
    db.prepare('DELETE FROM follows WHERE issue_id = ?').bind(source.id),
    db.prepare(`UPDATE issues SET updated_at = ${NOW_SQL}, version = version + 1 WHERE id = ?`).bind(target.id),
  ]);

  return c.json({
    issue: adminIssueToJSON(await loadIssue(db, source.id)),
    into: adminIssueToJSON(await loadIssue(db, target.id)),
  });
});

/** 409 that also returns the current row so the UI can reload it. */
class VersionConflict extends Error {
  constructor(readonly issue: ReturnType<typeof adminIssueToJSON>) {
    super('version conflict');
  }
}

admin.onError((err, c) => {
  if (err instanceof VersionConflict) {
    return c.json(
      {
        error: { code: 'version_conflict', message: 'This issue was changed elsewhere. Reload and try again.' },
        issue: err.issue,
      },
      409,
    );
  }
  throw err;
});
