import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireInstallation } from '../auth';
import { errors } from '../errors';
import { enforceLimit } from '../ratelimit';
import { readJSONObject, requireBoolean, requirePositiveInt } from '../validation';
import type { AppContext } from '../env';

/**
 * Votes and follows on public issues.
 *
 *   POST /api/vote    { issueNumber, on } -> { issueNumber, votes, voted, follows, following }
 *   POST /api/follow  { issueNumber, on } -> same shape
 *
 * Both are idempotent toggles: setting `on` to a state the row is already in
 * is a no-op success. Numbers of merged issues resolve to the retained issue,
 * so a vote on an old number lands where the discussion now lives.
 */
export const engage = new Hono<AppContext>();

interface IssueRef {
  id: string;
  number: number;
  merged_into: string | null;
}

/** Finds an issue by per-app number, following merge pointers (bounded). */
export async function resolveIssue(db: D1Database, appId: string, number: number): Promise<IssueRef> {
  const first = await db
    .prepare('SELECT id, number, merged_into FROM issues WHERE app_id = ? AND number = ?')
    .bind(appId, number)
    .first<IssueRef>();
  if (!first) throw errors.notFound('unknown_issue', 'No issue with that number.');

  let issue: IssueRef = first;
  for (let hops = 0; issue.merged_into && hops < 5; hops++) {
    const next: IssueRef | null = await db
      .prepare('SELECT id, number, merged_into FROM issues WHERE id = ?')
      .bind(issue.merged_into)
      .first<IssueRef>();
    if (!next) break;
    issue = next;
  }
  return issue;
}

export interface EngagementCounts {
  votes: number;
  voted: boolean;
  follows: number;
  following: boolean;
}

export async function engagementFor(
  db: D1Database,
  issueId: string,
  installationId: string | null,
): Promise<EngagementCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM votes   WHERE issue_id = ?1) AS votes,
         (SELECT COUNT(*) FROM follows WHERE issue_id = ?1) AS follows,
         EXISTS(SELECT 1 FROM votes   WHERE issue_id = ?1 AND installation_id = ?2) AS voted,
         EXISTS(SELECT 1 FROM follows WHERE issue_id = ?1 AND installation_id = ?2) AS following`,
    )
    .bind(issueId, installationId ?? '')
    .first<{ votes: number; follows: number; voted: number; following: number }>();
  return {
    votes: row?.votes ?? 0,
    voted: Boolean(row?.voted),
    follows: row?.follows ?? 0,
    following: Boolean(row?.following),
  };
}

function toggleRoute(table: 'votes' | 'follows') {
  return async (c: Context<AppContext>) => {
    const installation = c.var.installation;
    await enforceLimit(c.env.ENGAGE_INSTALLATION_LIMIT, installation.id);

    const input = await readJSONObject(c);
    const number = requirePositiveInt(input, 'issueNumber');
    const on = requireBoolean(input, 'on');

    const issue = await resolveIssue(c.env.DB, installation.appId, number);
    if (on) {
      await c.env.DB.prepare(`INSERT OR IGNORE INTO ${table} (issue_id, installation_id) VALUES (?, ?)`)
        .bind(issue.id, installation.id)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM ${table} WHERE issue_id = ? AND installation_id = ?`)
        .bind(issue.id, installation.id)
        .run();
    }

    const counts = await engagementFor(c.env.DB, issue.id, installation.id);
    return c.json({ issueNumber: issue.number, ...counts });
  };
}

engage.post('/vote', requireInstallation, toggleRoute('votes'));
engage.post('/follow', requireInstallation, toggleRoute('follows'));
