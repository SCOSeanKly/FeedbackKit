import { Hono } from 'hono';
import type { Context } from 'hono';
import { optionalInstallation } from '../auth';
import { errors } from '../errors';
import {
  ACTIVITY_DAYS,
  ACTIVITY_ROWS,
  BOARD_PAGE_SIZE,
  COLUMN_CAP,
  TIMELINE_PAGE_SIZE,
  isTimelineSpan,
  renderBoardPage,
  renderIssue,
  renderNotFound,
  renderProgressWidget,
  renderRoadmapPage,
  renderTimelinePage,
  type AppInfo,
  type BoardFilters,
  type BoardIssue,
  type BoardKind,
  type BoardStats,
  type ColumnData,
  type ProgressModel,
  type StatusChange,
  type TimelineFilters,
} from '../html';
import { ISSUE_STATUSES, ROADMAP_LANES, isIssueStatus, likePattern, type IssueStatus, type RoadmapLane } from '../issues';
import type { AppContext } from '../env';

/**
 * The public board and roadmap: reviewed issues only, never raw submissions.
 *
 *   GET /board                   every app, status columns (default) or list
 *   GET /board/:appId            one app, same views
 *   GET /board/:appId/:number    issue detail
 *   GET /roadmap                 Now / Next / Later / Shipped across apps
 *   GET /roadmap/:appId          one app
 *   GET /timeline                each issue's status journey as a bar chart
 *   GET /timeline/:appId         one app
 *   GET /embed/progress/:appId   self-contained "feedback and progress" card for an app's own site
 *   GET /api/board/:appId        JSON for the in-app BoardView (optional bearer
 *                                adds the caller's own voted/following flags)
 *   GET /api/stats/:appId        JSON of the board's activity tile (status totals
 *                                + 31-day report grid) for the home-screen widget
 *
 * Merged issues are hidden from lists; their numbers redirect to the
 * retained issue.
 */
export const board = new Hono<AppContext>();

const CACHE_HEADER = 'public, max-age=60, stale-while-revalidate=300';

interface BoardRow {
  id: string;
  app_id: string;
  app_name: string;
  number: number;
  title: string;
  body: string;
  status: IssueStatus;
  release: string | null;
  merged_into: string | null;
  roadmap_lane: RoadmapLane | null;
  created_at: string;
  updated_at: string;
  version: number;
  kind: BoardKind | null;
  votes: number;
  follows: number;
  voted: number;
  following: number;
}

/**
 * Issue columns plus app name, the kind of the earliest linked report, and
 * engagement counts. Bind parameter ?1 is always the caller's installation
 * id ('' for anonymous) so `voted` / `following` can be computed in SQL.
 */
const BOARD_COLUMNS = `
  i.id, i.app_id, a.name AS app_name, i.number, i.title, i.body, i.status, i."release",
  i.merged_into, i.roadmap_lane, i.created_at, i.updated_at, i.version,
  (SELECT s.kind FROM submission_issue_links l JOIN submissions s ON s.id = l.submission_id
     WHERE l.issue_id = i.id ORDER BY s.created_at LIMIT 1) AS kind,
  (SELECT COUNT(*) FROM votes v WHERE v.issue_id = i.id) AS votes,
  (SELECT COUNT(*) FROM follows f WHERE f.issue_id = i.id) AS follows,
  EXISTS(SELECT 1 FROM votes v WHERE v.issue_id = i.id AND v.installation_id = ?1) AS voted,
  EXISTS(SELECT 1 FROM follows f WHERE f.issue_id = i.id AND f.installation_id = ?1) AS following`;
const BOARD_FROM = 'FROM issues i JOIN apps a ON a.id = i.app_id';

function toBoardIssue(row: BoardRow): BoardIssue {
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    number: row.number,
    title: row.title,
    body: row.body,
    status: row.status,
    release: row.release,
    roadmapLane: row.roadmap_lane,
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    kind: row.kind,
    votes: row.votes,
    follows: row.follows,
    voted: Boolean(row.voted),
    following: Boolean(row.following),
  };
}

async function loadApps(db: D1Database): Promise<AppInfo[]> {
  const { results } = await db.prepare('SELECT id, name FROM apps ORDER BY name').all<AppInfo>();
  return results;
}

async function loadApp(db: D1Database, appId: string): Promise<AppInfo | null> {
  return db.prepare('SELECT id, name FROM apps WHERE id = ?').bind(appId).first<AppInfo>();
}

export type BoardSort = 'recent' | 'top';

function parseSort(value: string | null): BoardSort {
  return value === 'top' ? 'top' : 'recent';
}

function parseFilters(url: URL, apps: AppInfo[], crossApp: boolean): BoardFilters {
  const status = url.searchParams.get('status') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const appParam = crossApp ? (url.searchParams.get('app') ?? '') : '';
  const app = apps.some((a) => a.id === appParam) ? appParam : '';
  const validStatus: IssueStatus | '' = isIssueStatus(status) ? status : '';
  // A status filter only makes sense as a list; the columns already are the status breakdown.
  const view: BoardFilters['view'] = url.searchParams.get('view') === 'list' || validStatus ? 'list' : 'columns';
  return { view, app, status: validStatus, q, offset, sort: parseSort(url.searchParams.get('sort')) };
}

// MARK: Queries

/** Paged list. `appId` '' means every app; `me` '' means anonymous. */
export async function queryList(
  db: D1Database,
  me: string,
  appId: string,
  filters: Pick<BoardFilters, 'status' | 'q' | 'offset' | 'sort'>,
  pageSize = BOARD_PAGE_SIZE,
): Promise<{ issues: BoardIssue[]; hasMore: boolean }> {
  const order = filters.sort === 'top' ? 'votes DESC, i.updated_at DESC' : 'i.updated_at DESC';
  const { results } = await db
    .prepare(
      `SELECT ${BOARD_COLUMNS} ${BOARD_FROM}
       WHERE i.merged_into IS NULL
         AND (?2 = '' OR i.app_id = ?2)
         AND (?3 = '' OR i.status = ?3)
         AND (?4 = '' OR i.title LIKE ?5 ESCAPE '\\')
       ORDER BY ${order}, i.number DESC
       LIMIT ?6 OFFSET ?7`,
    )
    .bind(me, appId, filters.status, filters.q, likePattern(filters.q), pageSize + 1, filters.offset)
    .all<BoardRow>();
  return {
    issues: results.slice(0, pageSize).map(toBoardIssue),
    hasMore: results.length > pageSize,
  };
}

/** Up to COLUMN_CAP newest issues per status, with exact totals, in one query. */
async function queryColumns(db: D1Database, appId: string, q: string): Promise<Record<IssueStatus, ColumnData>> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${BOARD_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY i.status ORDER BY i.updated_at DESC, i.number DESC) AS rn,
                COUNT(*) OVER (PARTITION BY i.status) AS status_total
         ${BOARD_FROM}
         WHERE i.merged_into IS NULL
           AND (?2 = '' OR i.app_id = ?2)
           AND (?3 = '' OR i.title LIKE ?4 ESCAPE '\\')
       ) WHERE rn <= ?5
       ORDER BY status, rn`,
    )
    .bind('', appId, q, likePattern(q), COLUMN_CAP)
    .all<BoardRow & { rn: number; status_total: number }>();

  const columns = Object.fromEntries(
    ISSUE_STATUSES.map((s) => [s, { total: 0, items: [] as BoardIssue[] }]),
  ) as Record<IssueStatus, ColumnData>;
  for (const row of results) {
    const col = columns[row.status];
    if (!col) continue;
    col.total = row.status_total;
    col.items.push(toBoardIssue(row));
  }

  // Accurate per-release counts for the Complete column, independent of the cap.
  const { results: groups } = await db
    .prepare(
      `SELECT i."release" AS release, COUNT(*) AS count FROM issues i
       WHERE i.status = 'complete' AND i.merged_into IS NULL
         AND (?1 = '' OR i.app_id = ?1)
         AND (?2 = '' OR i.title LIKE ?3 ESCAPE '\\')
       GROUP BY i."release"`,
    )
    .bind(appId, q, likePattern(q))
    .all<{ release: string | null; count: number }>();
  columns.complete.releaseGroups = groups;

  return columns;
}

/**
 * Issues placed on the roadmap. Open ones sit in their lane, most voted first;
 * Complete ones move to Shipped (newest first) regardless of lane; Closed ones
 * drop off the roadmap entirely.
 */
async function queryRoadmap(db: D1Database, appId: string): Promise<{ lanes: Record<RoadmapLane, BoardIssue[]>; shipped: BoardIssue[] }> {
  const batch = await db.batch<BoardRow>([
    db
      .prepare(
        `SELECT ${BOARD_COLUMNS} ${BOARD_FROM}
         WHERE i.merged_into IS NULL AND i.roadmap_lane IS NOT NULL
           AND i.status NOT IN ('complete', 'closed')
           AND (?2 = '' OR i.app_id = ?2)
         ORDER BY votes DESC, i.updated_at DESC`,
      )
      .bind('', appId),
    db
      .prepare(
        `SELECT ${BOARD_COLUMNS} ${BOARD_FROM}
         WHERE i.merged_into IS NULL AND i.roadmap_lane IS NOT NULL
           AND i.status = 'complete'
           AND (?2 = '' OR i.app_id = ?2)
         ORDER BY i.updated_at DESC, i.number DESC
         LIMIT ?3`,
      )
      .bind('', appId, COLUMN_CAP),
  ]);
  const open = batch[0];
  const done = batch[1];
  if (!open || !done) throw new Error('Roadmap batch returned fewer results than expected');
  const lanes = Object.fromEntries(ROADMAP_LANES.map((l) => [l, [] as BoardIssue[]])) as Record<RoadmapLane, BoardIssue[]>;
  for (const row of open.results) {
    if (row.roadmap_lane && lanes[row.roadmap_lane]) lanes[row.roadmap_lane].push(toBoardIssue(row));
  }
  return { lanes, shipped: done.results.map(toBoardIssue) };
}

// MARK: Timeline

function parseTimelineFilters(url: URL, apps: AppInfo[], crossApp: boolean): TimelineFilters {
  const status = url.searchParams.get('status') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const appParam = crossApp ? (url.searchParams.get('app') ?? '') : '';
  const app = apps.some((a) => a.id === appParam) ? appParam : '';
  const spanParam = url.searchParams.get('span');
  return { app, status: isIssueStatus(status) ? status : '', q, span: isTimelineSpan(spanParam) ? spanParam : 'fit', offset };
}

/** A page of issues (most recently updated first) with each one's status history, plus the filtered total. */
async function queryTimeline(
  db: D1Database,
  appId: string,
  filters: TimelineFilters,
): Promise<{ rows: { issue: BoardIssue; history: StatusChange[] }[]; total: number; hasMore: boolean }> {
  const where = `WHERE i.merged_into IS NULL
         AND (?2 = '' OR i.app_id = ?2)
         AND (?3 = '' OR i.status = ?3)
         AND (?4 = '' OR i.title LIKE ?5 ESCAPE '\\')`;
  const batch = await db.batch([
    db
      .prepare(`SELECT ${BOARD_COLUMNS} ${BOARD_FROM} ${where} ORDER BY i.updated_at DESC, i.number DESC LIMIT ?6 OFFSET ?7`)
      .bind('', appId, filters.status, filters.q, likePattern(filters.q), TIMELINE_PAGE_SIZE + 1, filters.offset),
    db.prepare(`SELECT COUNT(*) AS n ${BOARD_FROM} ${where}`).bind('', appId, filters.status, filters.q, likePattern(filters.q)),
  ]);
  const page = batch[0]?.results as BoardRow[] | undefined;
  const count = batch[1]?.results?.[0] as { n: number } | undefined;
  if (!page || !count) throw new Error('Timeline batch returned fewer results than expected');

  const issues = page.slice(0, TIMELINE_PAGE_SIZE).map(toBoardIssue);
  const historyByIssue = new Map<string, StatusChange[]>();
  if (issues.length > 0) {
    const placeholders = issues.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT issue_id, status, changed_at FROM issue_status_history
         WHERE issue_id IN (${placeholders}) ORDER BY issue_id, changed_at, id`,
      )
      .bind(...issues.map((i) => i.id))
      .all<{ issue_id: string; status: IssueStatus; changed_at: string }>();
    for (const row of results) {
      const list = historyByIssue.get(row.issue_id) ?? [];
      list.push({ status: row.status, at: row.changed_at });
      historyByIssue.set(row.issue_id, list);
    }
  }
  return {
    rows: issues.map((issue) => ({ issue, history: historyByIssue.get(issue.id) ?? [] })),
    total: count.n,
    hasMore: page.length > TIMELINE_PAGE_SIZE,
  };
}

/** Totals plus a status-by-day grid for the embeddable progress card. Counts only. */
async function queryProgress(db: D1Database, app: AppInfo): Promise<ProgressModel> {
  const since = `-${ACTIVITY_DAYS - 1} days`;
  const batch = await db.batch<{ status?: IssueStatus; day?: string; n: number }>([
    db
      .prepare(`SELECT status, COUNT(*) AS n FROM issues WHERE merged_into IS NULL AND app_id = ?1 GROUP BY status`)
      .bind(app.id),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM submissions
         WHERE app_id = ?1 AND created_at >= strftime('%Y-%m-%dT00:00:00Z', 'now', ?2) GROUP BY day`,
      )
      .bind(app.id, since),
    db
      .prepare(
        `SELECT h.status, substr(h.changed_at, 1, 10) AS day, COUNT(*) AS n
         FROM issue_status_history h JOIN issues i ON i.id = h.issue_id
         WHERE i.app_id = ?1 AND i.merged_into IS NULL AND h.status <> 'reported'
           AND h.changed_at >= strftime('%Y-%m-%dT00:00:00Z', 'now', ?2)
         GROUP BY h.status, day`,
      )
      .bind(app.id, since),
  ]);
  const totals = batch[0];
  const reports = batch[1];
  const changes = batch[2];
  if (!totals || !reports || !changes) throw new Error('Progress batch returned fewer results than expected');

  const byStatus = Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  for (const row of totals.results) if (row.status && row.status in byStatus) byStatus[row.status] = row.n;

  const days: string[] = [];
  const today = new Date();
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10));
  }
  const index = new Map(days.map((d, i) => [d, i]));
  const grid = Object.fromEntries(ISSUE_STATUSES.map((s) => [s, days.map(() => 0)])) as Record<IssueStatus, number[]>;
  let reportsInWindow = 0;
  for (const row of reports.results) {
    const i = index.get(row.day ?? '');
    if (i !== undefined) grid.reported[i] = row.n;
    reportsInWindow += row.n;
  }
  for (const row of changes.results) {
    const i = index.get(row.day ?? '');
    if (i !== undefined && row.status && row.status in grid) grid[row.status][i] = row.n;
  }
  return { app, byStatus, reportsInWindow, days, grid };
}

/**
 * Status totals plus, for the activity grid, each day's reports coloured by
 * the status of the issue they were linked to (`reported` when unlinked).
 * Counts only, no text.
 */
async function queryStats(db: D1Database, appId: string): Promise<BoardStats> {
  const batch = await db.batch<{ status?: IssueStatus; day?: string; n: number }>([
    db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM issues
         WHERE merged_into IS NULL AND (?1 = '' OR app_id = ?1) GROUP BY status`,
      )
      .bind(appId),
    db
      .prepare(
        `SELECT substr(s.created_at, 1, 10) AS day, COALESCE(i.status, 'reported') AS status, COUNT(*) AS n
         FROM submissions s
         LEFT JOIN submission_issue_links l ON l.submission_id = s.id
         LEFT JOIN issues i ON i.id = l.issue_id
         WHERE (?1 = '' OR s.app_id = ?1)
           AND s.created_at >= strftime('%Y-%m-%dT00:00:00Z', 'now', ?2)
         GROUP BY day, status`,
      )
      .bind(appId, `-${ACTIVITY_DAYS - 1} days`),
  ]);
  const statusRows = batch[0];
  const dayRows = batch[1];
  if (!statusRows || !dayRows) throw new Error('Stats batch returned fewer results than expected');

  const byStatus = Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  let total = 0;
  for (const row of statusRows.results) {
    if (row.status && row.status in byStatus) {
      byStatus[row.status] = row.n;
      total += row.n;
    }
  }

  // Per day, one status per report, ordered so finished work sits lowest in
  // the column and fresh reports stack on top.
  const rank = new Map(ISSUE_STATUSES.map((s, i) => [s, i]));
  const perDay = new Map<string, IssueStatus[]>();
  for (const row of dayRows.results) {
    const status: IssueStatus = row.status && rank.has(row.status) ? row.status : 'reported';
    const list = perDay.get(row.day ?? '') ?? [];
    for (let k = 0; k < row.n; k++) list.push(status);
    perDay.set(row.day ?? '', list);
  }
  const days: BoardStats['days'] = [];
  const today = new Date();
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const cells = (perDay.get(key) ?? []).sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
    days.push({ day: key, count: cells.length, cells });
  }
  const reportsInWindow = days.reduce((sum, d) => sum + d.count, 0);

  return { total, byStatus, reportsInWindow, days };
}

// MARK: Pages

async function renderBoardFor(c: Context<AppContext>, app: AppInfo | null): Promise<Response> {
  const db = c.env.DB;
  const apps = await loadApps(db);
  const filters = parseFilters(new URL(c.req.url), apps, app === null);
  const scope = app ? app.id : filters.app;

  const stats = await queryStats(db, scope);
  const model = { app, apps, filters, stats } as Parameters<typeof renderBoardPage>[0];
  if (filters.view === 'list') {
    model.list = await queryList(db, '', scope, filters);
  } else {
    model.columns = await queryColumns(db, scope, filters.q);
  }

  c.header('Cache-Control', CACHE_HEADER);
  return c.html(renderBoardPage(model));
}

async function renderRoadmapFor(c: Context<AppContext>, app: AppInfo | null): Promise<Response> {
  const db = c.env.DB;
  const apps = await loadApps(db);
  const appParam = app ? '' : (new URL(c.req.url).searchParams.get('app') ?? '');
  const selectedApp = apps.some((a) => a.id === appParam) ? appParam : '';
  const scope = app ? app.id : selectedApp;
  const { lanes, shipped } = await queryRoadmap(db, scope);
  c.header('Cache-Control', CACHE_HEADER);
  return c.html(renderRoadmapPage({ app, apps, selectedApp, lanes, shipped }));
}

async function renderTimelineFor(c: Context<AppContext>, app: AppInfo | null): Promise<Response> {
  const db = c.env.DB;
  const apps = await loadApps(db);
  const filters = parseTimelineFilters(new URL(c.req.url), apps, app === null);
  const scope = app ? app.id : filters.app;
  const { rows, total, hasMore } = await queryTimeline(db, scope, filters);
  c.header('Cache-Control', CACHE_HEADER);
  return c.html(renderTimelinePage({ app, apps, filters, rows, total, hasMore, now: Date.now() }));
}

board.get('/board', (c) => renderBoardFor(c, null));
board.get('/roadmap', (c) => renderRoadmapFor(c, null));
board.get('/timeline', (c) => renderTimelineFor(c, null));

board.get('/timeline/:appId', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) return c.html(renderNotFound('No timeline exists for that app.'), 404);
  return renderTimelineFor(c, app);
});

board.get('/embed/progress/:appId', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) return c.html(renderNotFound('No such app.'), 404);
  const model = await queryProgress(c.env.DB, app);
  c.header('Cache-Control', CACHE_HEADER);
  return c.html(renderProgressWidget(model));
});

board.get('/board/:appId', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) return c.html(renderNotFound('No board exists for that app.'), 404);
  return renderBoardFor(c, app);
});

board.get('/roadmap/:appId', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) return c.html(renderNotFound('No roadmap exists for that app.'), 404);
  return renderRoadmapFor(c, app);
});

board.get('/board/:appId/:number', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) return c.html(renderNotFound('No board exists for that app.'), 404);

  const number = Number(c.req.param('number'));
  if (!Number.isInteger(number) || number <= 0) {
    return c.html(renderNotFound('That item does not exist.'), 404);
  }

  const row = await c.env.DB.prepare(`SELECT ${BOARD_COLUMNS} ${BOARD_FROM} WHERE i.app_id = ?2 AND i.number = ?3`)
    .bind('', app.id, number)
    .first<BoardRow>();
  if (!row) return c.html(renderNotFound('That item does not exist.'), 404);

  if (row.merged_into) {
    const target = await c.env.DB.prepare('SELECT number FROM issues WHERE id = ?')
      .bind(row.merged_into)
      .first<{ number: number }>();
    if (target) return c.redirect(`/board/${encodeURIComponent(app.id)}/${target.number}`, 301);
  }

  c.header('Cache-Control', CACHE_HEADER);
  return c.html(renderIssue(app, toBoardIssue(row)));
});

board.get('/api/board/:appId', optionalInstallation, async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) throw errors.notFound('unknown_app', 'No app with that id is registered.');

  const me = c.var.maybeInstallation?.id ?? '';
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status') ?? '';
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const page = await queryList(c.env.DB, me, app.id, {
    status: isIssueStatus(status) ? status : '',
    q: (url.searchParams.get('q') ?? '').trim().slice(0, 100),
    offset: Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
    sort: parseSort(url.searchParams.get('sort')),
  });
  // Personalised when a token is present; only the anonymous form is cacheable.
  c.header('Cache-Control', me ? 'private, no-store' : CACHE_HEADER);
  return c.json({ app, ...page });
});

// The activity tile's numbers, exactly as the board page draws them, for the
// NuKey home-screen widget. Counts only — the same `queryStats` the public
// page uses — so nothing here needs a token and the response is cacheable.
// `days`/`rows` tell the client the grid's shape rather than having it assume.
board.get('/api/stats/:appId', async (c) => {
  const app = await loadApp(c.env.DB, c.req.param('appId'));
  if (!app) throw errors.notFound('unknown_app', 'No app with that id is registered.');
  const stats = await queryStats(c.env.DB, app.id);
  c.header('Cache-Control', CACHE_HEADER);
  return c.json({ app, days: ACTIVITY_DAYS, rows: ACTIVITY_ROWS, stats });
});
