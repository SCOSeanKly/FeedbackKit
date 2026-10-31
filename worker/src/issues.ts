/**
 * Shared vocabulary for reviewed public issues, used by the admin API, the
 * public board and (later) the roadmap.
 */

export const ISSUE_STATUSES = [
  'reported',
  'planned',
  'in_progress',
  'pending',
  'testing',
  'complete',
  'closed',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  reported: 'Reported',
  planned: 'Planned',
  in_progress: 'In progress',
  pending: 'Pending',
  testing: 'Testing',
  complete: 'Complete',
  closed: 'Closed',
};

export const ROADMAP_LANES = ['now', 'next', 'later'] as const;
export type RoadmapLane = (typeof ROADMAP_LANES)[number];

export const ISSUE_LIMITS = {
  title: { min: 3, max: 160 },
  body: { max: 10_000 },
  release: { max: 40 },
} as const;

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value);
}

/** Row shape of the `issues` table. */
export interface IssueRow {
  id: string;
  app_id: string;
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
}

export interface IssueJSON {
  id: string;
  number: number;
  title: string;
  body: string;
  status: IssueStatus;
  release: string | null;
  roadmapLane: RoadmapLane | null;
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function issueToJSON(row: IssueRow): IssueJSON {
  return {
    id: row.id,
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
  };
}

/** Every column of `issues`, with the keyword column quoted. */
export const ISSUE_COLUMNS =
  'id, app_id, number, title, body, status, "release", merged_into, roadmap_lane, created_at, updated_at, version';

/**
 * Turns free text into a safe `LIKE` pattern: wildcard characters in the
 * input are escaped so they match literally. Use with `ESCAPE '\'`.
 */
export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
