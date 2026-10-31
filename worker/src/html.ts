import { ISSUE_STATUSES, ROADMAP_LANES, STATUS_LABELS, type IssueJSON, type IssueStatus, type RoadmapLane } from './issues';

/**
 * Server-rendered public pages. Everything that originated as user or
 * developer text passes through `escapeHTML`; there is no raw interpolation.
 */

export function escapeHTML(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text split on blank lines into paragraphs, single newlines kept as <br>. */
export function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHTML(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// MARK: - Models handed to the renderer

export interface AppInfo {
  id: string;
  name: string;
}

export type BoardKind = 'issue' | 'idea' | 'other';

/** A public issue plus the extra bits the board shows. */
export interface BoardIssue extends IssueJSON {
  appId: string;
  appName: string;
  kind: BoardKind | null;
  votes: number;
  follows: number;
  /** The caller's own state; always false on anonymous pages. */
  voted: boolean;
  following: boolean;
}

export interface BoardFilters {
  view: 'columns' | 'list';
  /** Cross-app board only: '' means every app. */
  app: string;
  status: IssueStatus | '';
  q: string;
  offset: number;
  sort: 'recent' | 'top';
}

export interface RoadmapPageModel {
  app: AppInfo | null;
  apps: AppInfo[];
  selectedApp: string;
  lanes: Record<RoadmapLane, BoardIssue[]>;
  /** Roadmap items that reached Complete, newest first; shown grouped by release. */
  shipped: BoardIssue[];
}

// MARK: Timeline

export type TimelineSpan = 'fit' | '30d' | '7d' | '1d' | '6h' | '1h';
export const TIMELINE_SPANS: { id: TimelineSpan; label: string; ms: number | null }[] = [
  { id: 'fit', label: 'Fit', ms: null },
  { id: '30d', label: '30d', ms: 30 * 864e5 },
  { id: '7d', label: '7d', ms: 7 * 864e5 },
  { id: '1d', label: '1d', ms: 864e5 },
  { id: '6h', label: '6h', ms: 6 * 36e5 },
  { id: '1h', label: '1h', ms: 36e5 },
];
export const TIMELINE_PAGE_SIZE = 25;

export function isTimelineSpan(value: string | null): value is TimelineSpan {
  return TIMELINE_SPANS.some((s) => s.id === value);
}

export interface StatusChange {
  status: IssueStatus;
  at: string;
}

export interface TimelineFilters {
  app: string;
  status: IssueStatus | '';
  q: string;
  span: TimelineSpan;
  offset: number;
}

export interface TimelinePageModel {
  app: AppInfo | null;
  apps: AppInfo[];
  filters: TimelineFilters;
  rows: { issue: BoardIssue; history: StatusChange[] }[];
  total: number;
  hasMore: boolean;
  /** Milliseconds since the epoch; the right edge of every chart. */
  now: number;
}

// MARK: Progress widget (embeddable)

export interface ProgressModel {
  app: AppInfo;
  byStatus: Record<IssueStatus, number>;
  reportsInWindow: number;
  /** Oldest first, ACTIVITY_DAYS entries of YYYY-MM-DD. */
  days: string[];
  /** Per status, one count per day: Reported = reports received, others = issues entering that status. */
  grid: Record<IssueStatus, number[]>;
}

const LANE_LABELS: Record<RoadmapLane, string> = { now: 'Now', next: 'Next', later: 'Later' };
const LANE_HINTS: Record<RoadmapLane, string> = {
  now: 'Being worked on',
  next: 'Coming up after that',
  later: 'On the list, not yet scheduled',
};

export interface ColumnData {
  total: number;
  items: BoardIssue[];
  /** Complete column only: accurate per-release counts. */
  releaseGroups?: { release: string | null; count: number }[];
}

export interface BoardStats {
  total: number;
  byStatus: Record<IssueStatus, number>;
  reportsInWindow: number;
  /** One entry per day, oldest first; `cells` is one status per report (linked issue's status, or `reported`). */
  days: { day: string; count: number; cells: IssueStatus[] }[];
}

export interface BoardPageModel {
  app: AppInfo | null;
  apps: AppInfo[];
  filters: BoardFilters;
  stats: BoardStats;
  list?: { issues: BoardIssue[]; hasMore: boolean };
  columns?: Record<IssueStatus, ColumnData>;
}

export const BOARD_PAGE_SIZE = 25;
export const COLUMN_CAP = 100;
export const ACTIVITY_DAYS = 31;
/** Rows in the activity grid: one cell per report per day, extra reports collapse into the top cell. */
export const ACTIVITY_ROWS = 5;

/**
 * The feedback suite's own identity, shown as "Powered by" on every public
 * page and mirrored by `FeedbackBrand` in the Swift package. One place to
 * rename it.
 */
export const BRAND = { name: 'Nuke', url: '/' } as const;

const KIND_LABELS: Record<BoardKind, string> = { issue: 'Issue', idea: 'Idea', other: 'Other' };

// MARK: - Shell

// Dark palette is applied both by OS preference and by an explicit
// data-theme, so an embedding page can pin the scheme it uses itself.
const DARK_VARS = `--fg: #f5f5f7; --muted: #a1a1a6; --bg: #000; --card: #1c1c1e; --panel: #2c2c2e; --line: #3a3a3c; --accent: #2997ff;`;
const DARK_BADGES = `.badge.s-planned, .badge.s-in_progress, .badge.s-testing, .badge.s-complete { background: var(--line); }`;

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --card: #f5f5f7; --panel: #fff; --line: #e5e5ea; --accent: #0071e3; }
:root[data-theme=light] { color-scheme: light; }
:root[data-theme=dark] { color-scheme: dark; ${DARK_VARS} }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { ${DARK_VARS} } :root:not([data-theme=light]) ${DARK_BADGES} }
:root[data-theme=dark] ${DARK_BADGES}
html.embedded body { background: transparent; }
html.embedded main { padding: 0 0 8px; }
html.embedded header.site .crumb, html.embedded header.site h1, html.embedded header.site p.sub { display: none; }
html.embedded header.site { align-items: center; }
html.embedded nav.tabs { margin-top: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1600px; margin: 0 auto; padding: 24px 20px 64px; }
main.narrow { max-width: 760px; }
a { color: var(--accent); }
header.site { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; }
header.site .crumb { font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
header.site .crumb a { color: inherit; text-decoration: none; }
header.site h1 { font-size: 28px; margin: 0 0 4px; }
header.site p.sub { margin: 0; color: var(--muted); }
nav.tabs { display: inline-flex; gap: 4px; margin-top: 12px; }
nav.tabs a { text-decoration: none; color: var(--muted); padding: 6px 12px; border-radius: 999px; font-size: 14px; }
nav.tabs a.on { background: var(--card); color: var(--fg); font-weight: 600; }
.votes { font-variant-numeric: tabular-nums; white-space: nowrap; }
.lane-hint { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
.stats { background: var(--card); border-radius: 14px; padding: 14px 16px; min-width: 300px; flex: 0 1 380px; }
.stats .top { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; margin-bottom: 10px; }
.stats .top strong { font-weight: 600; }
.stats .top span { color: var(--muted); }
.activity { display: grid; grid-template-columns: repeat(${ACTIVITY_DAYS}, 1fr); gap: 3px; }
.activity .day { display: grid; grid-template-rows: repeat(${ACTIVITY_ROWS}, 1fr); gap: 3px; aspect-ratio: 1 / ${ACTIVITY_ROWS}; }
.activity .c { display: block; border-radius: 2px; background: var(--line); }
.activity .c.s-reported { background: #8e8e93; } .activity .c.s-planned { background: #c9a227; } .activity .c.s-in_progress { background: #1a56db; }
.activity .c.s-pending { background: #b45309; } .activity .c.s-testing { background: #7e22ce; } .activity .c.s-complete { background: #15803d; } .activity .c.s-closed { background: #636366; }
.activity .c.more { box-shadow: inset 0 0 0 1.5px var(--card); }
.stats .bottom { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; font-size: 13px; color: var(--muted); }
.stats .bottom b { font-weight: 600; }
.stats .bottom .s-reported b { color: var(--fg); } .stats .bottom .s-in_progress b { color: #1a56db; } .stats .bottom .s-complete b { color: #15803d; }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) .stats .bottom .s-in_progress b { color: #5e9bff; } :root:not([data-theme=light]) .stats .bottom .s-complete b { color: #34c759; } }
:root[data-theme=dark] .stats .bottom .s-in_progress b { color: #5e9bff; } :root[data-theme=dark] .stats .bottom .s-complete b { color: #34c759; }
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 18px; }
.toolbar form { display: contents; }
.toolbar select, .toolbar input[type=search], .toolbar button, .seg a { font: inherit; color: var(--fg); padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.toolbar input[type=search] { flex: 1 1 220px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.seg a { border: 0; border-radius: 0; text-decoration: none; color: var(--muted); background: var(--bg); }
.seg a.on { background: var(--card); color: var(--fg); font-weight: 600; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--line); color: var(--fg); white-space: nowrap; }
.badge.s-planned { background: #e8f0fe; color: #1a56db; } .badge.s-in_progress { background: #fff4e5; color: #b45309; }
.badge.s-testing { background: #f3e8ff; color: #7e22ce; } .badge.s-complete { background: #e6f7ee; color: #15803d; }
.badge.s-closed { background: var(--line); color: var(--muted); }
@media (prefers-color-scheme: dark) { .badge.s-planned, .badge.s-in_progress, .badge.s-testing, .badge.s-complete { background: var(--line); } }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 8px; }
.dot.s-planned { background: #c9a227; } .dot.s-in_progress { background: #1a56db; } .dot.s-pending { background: #b45309; }
.dot.s-testing { background: #7e22ce; } .dot.s-complete { background: #15803d; } .dot.s-closed { background: #8e8e93; }
.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(205px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
.col { background: var(--card); border-radius: 14px; padding: 10px; min-height: 160px; }
.col-head { display: flex; align-items: center; padding: 6px 6px 10px; font-weight: 600; font-size: 14px; }
.col-head .count { margin-left: auto; color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.card { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; color: inherit; text-decoration: none; }
.card:hover { border-color: var(--accent); }
.card-top { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.card-title { font-weight: 600; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
.card-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); }
.card-meta span { white-space: nowrap; }
.card-meta span:first-child { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.col .empty { color: var(--muted); font-size: 14px; text-align: center; padding: 36px 8px; }
.col .more { display: block; text-align: center; font-size: 13px; padding: 8px; }
details.release { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; }
details.release summary { cursor: pointer; padding: 10px 12px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; list-style: none; }
details.release summary::-webkit-details-marker { display: none; }
details.release summary::before { content: "›"; color: var(--muted); flex: 0 0 auto; transition: transform .15s; }
details[open].release summary::before { transform: rotate(90deg); }
details.release summary .label { flex: 1 1 auto; overflow-wrap: anywhere; }
details.release summary .n { color: var(--muted); font-weight: 500; white-space: nowrap; }
details.release .card { margin: 0 8px 8px; }
.issue { display: block; padding: 14px 16px; margin-bottom: 10px; border-radius: 12px; background: var(--card); color: inherit; text-decoration: none; }
.issue:hover { outline: 2px solid var(--accent); outline-offset: -2px; }
.issue .top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.issue .number { color: var(--muted); font-variant-numeric: tabular-nums; }
.issue .title { font-weight: 600; flex: 1 1 auto; }
.release-tag { font-size: 13px; color: var(--muted); }
.meta { color: var(--muted); font-size: 14px; margin-top: 4px; }
.empty-page { color: var(--muted); padding: 32px 0; text-align: center; }
.pager { display: flex; justify-content: space-between; margin-top: 16px; }
article.detail h2 { margin: 0 0 6px; font-size: 22px; }
article.detail .body { margin-top: 16px; }
article.detail .body p { margin: 0 0 12px; overflow-wrap: anywhere; }
.tl-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; color: var(--muted); font-size: 14px; }
.tl-tools .spans { display: inline-flex; align-items: center; gap: 8px; }
.tl { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); overflow: hidden; }
.tl-scroll { overflow-x: auto; }
.tl-grid { display: grid; grid-template-columns: 300px minmax(560px, 1fr); min-width: 880px; }
.tl-head { display: contents; }
.tl-head > div { background: var(--card); border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; }
.tl-head > div:first-child { padding: 14px; }
.tl-axis { position: relative; height: 46px; }
.tl-axis .tick { position: absolute; top: 12px; transform: translateX(-50%); font-size: 12px; color: var(--muted); font-weight: 500; white-space: nowrap; }
.tl-axis .now { position: absolute; right: 6px; top: 26px; font-size: 12px; color: #d9480f; font-weight: 600; }
.tl-row { display: contents; }
.tl-row > div { border-bottom: 1px solid var(--line); }
.tl-row:last-child > div { border-bottom: 0; }
.tl-label { padding: 12px 14px; min-width: 0; }
.tl-label a { display: block; color: inherit; text-decoration: none; font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-label a .n { color: var(--muted); font-weight: 500; margin-right: 6px; font-variant-numeric: tabular-nums; }
.tl-label .meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
.track { position: relative; height: 100%; min-height: 66px; }
.track .grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); }
.track .nowline { position: absolute; top: 0; bottom: 0; right: 0; border-left: 1px dashed var(--muted); opacity: .6; }
.bar { position: absolute; top: 50%; height: 26px; margin-top: -13px; display: flex; align-items: center; justify-content: center; overflow: hidden; font-size: 12px; font-weight: 600; color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,.28); white-space: nowrap; }
.bar.first { border-radius: 5px 0 0 5px; } .bar.last { border-radius: 0 5px 5px 0; } .bar.first.last { border-radius: 5px; }
.bar.end { min-width: 5px; border-radius: 3px; }
.bar.s-reported { background: #8e8e93; } .bar.s-planned { background: #c9a227; } .bar.s-in_progress { background: #1a56db; }
.bar.s-pending { background: #b45309; } .bar.s-testing { background: #7e22ce; } .bar.s-complete { background: #15803d; } .bar.s-closed { background: #8e6c7a; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin-top: 12px; }
.legend span { display: inline-flex; align-items: center; } .legend .dot { margin-right: 6px; }
footer.site { margin-top: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
html.embedded footer.site { margin-top: 28px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--fg); text-decoration: none; }
.brand svg { width: 30px; height: 30px; flex: none; }
.brand .mark-bg { fill: var(--fg); } .brand .mark-fg { fill: var(--bg); }
.brand .words { display: grid; line-height: 1.15; }
.brand .words small { font-size: 10.5px; color: var(--muted); letter-spacing: .01em; }
.brand .words b { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
@media (max-width: 760px) {
  main { padding: 16px 12px 48px; }
  header.site h1 { font-size: 24px; }
  .stats { flex-basis: 100%; min-width: 0; }
  .columns { grid-auto-flow: row; grid-auto-columns: auto; overflow: visible; }
  .col { min-height: 0; }
  .col.is-empty { padding-bottom: 2px; }
  .col.is-empty .col-head { padding-bottom: 6px; }
  .col.is-empty .empty { display: none; }
}
`;

export function layout(options: { title: string; body: string; description?: string; narrow?: boolean; footerNote?: string }): string {
  const note = options.footerNote ?? 'Only reviewed, published items appear here. Submit feedback from inside the app.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(options.title)}</title>
${options.description ? `<meta name="description" content="${escapeHTML(options.description)}">` : ''}
<style>${CSS}</style>
<script>${EMBED_SCRIPT}</script>
</head>
<body>
<main${options.narrow ? ' class="narrow"' : ''}>
${options.body}
<footer class="site">${brandBadge()}<span>${escapeHTML(note)}</span></footer>
</main>
</body>
</html>`;
}

/**
 * Runs before first paint. When framed by another site it marks the document
 * `embedded` (hides the duplicate page header, transparent background),
 * honours a theme the parent pins via postMessage (remembered for in-frame
 * navigation), and reports its height so the parent can size the frame.
 */
const EMBED_SCRIPT = `
(function () {
  var root = document.documentElement;
  var framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (!framed) return;
  root.classList.add('embedded');
  var theme = null;
  try { theme = sessionStorage.getItem('fk-theme'); } catch (e) {}
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  function report() {
    parent.postMessage({ type: 'fk:height', height: root.scrollHeight }, '*');
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'fk:theme') return;
    if (data.theme === 'light' || data.theme === 'dark') {
      root.setAttribute('data-theme', data.theme);
      try { sessionStorage.setItem('fk-theme', data.theme); } catch (e) {}
    } else {
      root.removeAttribute('data-theme');
      try { sessionStorage.removeItem('fk-theme'); } catch (e) {}
    }
    report();
  });
  window.addEventListener('DOMContentLoaded', function () {
    report();
    if ('ResizeObserver' in window) new ResizeObserver(report).observe(document.body);
    document.addEventListener('toggle', report, true);
  });
  window.addEventListener('load', report);
})();
`;

/** The brand mark: a speech bubble holding three rising bars. Inline so pages stay self-contained. */
export function brandMark(size: number): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
<rect class="mark-bg" width="32" height="32" rx="8"/>
<path class="mark-fg" d="M9 7h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H14l-5 4v-4a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z"/>
<rect class="mark-bg" x="11" y="15" width="2.6" height="4.5" rx="1.3"/>
<rect class="mark-bg" x="14.7" y="12.5" width="2.6" height="7" rx="1.3"/>
<rect class="mark-bg" x="18.4" y="10" width="2.6" height="9.5" rx="1.3"/>
</svg>`;
}

function brandBadge(): string {
  return `<a class="brand" href="${BRAND.url}" target="_top" aria-label="Powered by ${escapeHTML(BRAND.name)}">${brandMark(30)}<span class="words"><small>Powered by</small><b>${escapeHTML(BRAND.name)}</b></span></a>`;
}

// MARK: - Pieces

function statusBadge(status: IssueStatus): string {
  return `<span class="badge s-${escapeHTML(status)}">${escapeHTML(STATUS_LABELS[status])}</span>`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function boardPath(app: AppInfo | null): string {
  return app ? `/board/${encodeURIComponent(app.id)}` : '/board';
}

function roadmapPath(app: AppInfo | null): string {
  return app ? `/roadmap/${encodeURIComponent(app.id)}` : '/roadmap';
}

function timelinePath(app: AppInfo | null): string {
  return app ? `/timeline/${encodeURIComponent(app.id)}` : '/timeline';
}

function tabs(app: AppInfo | null, active: 'board' | 'roadmap' | 'timeline', appQuery = ''): string {
  const suffix = !app && appQuery ? `?app=${encodeURIComponent(appQuery)}` : '';
  return `<nav class="tabs" aria-label="Section">
  <a href="${boardPath(app)}${suffix}"${active === 'board' ? ' class="on"' : ''}>Board</a>
  <a href="${roadmapPath(app)}${suffix}"${active === 'roadmap' ? ' class="on"' : ''}>Roadmap</a>
  <a href="${timelinePath(app)}${suffix}"${active === 'timeline' ? ' class="on"' : ''}>Timeline</a>
</nav>`;
}

function issuePath(issue: BoardIssue): string {
  return `/board/${encodeURIComponent(issue.appId)}/${issue.number}`;
}

/** Builds a board URL from the current filters with some fields overridden. */
function href(app: AppInfo | null, filters: BoardFilters, overrides: Partial<BoardFilters>): string {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.view === 'list') params.set('view', 'list');
  if (f.sort === 'top') params.set('sort', 'top');
  if (!app && f.app) params.set('app', f.app);
  if (f.status) params.set('status', f.status);
  if (f.q) params.set('q', f.q);
  if (f.offset > 0) params.set('offset', String(f.offset));
  const query = params.toString();
  return query ? `${boardPath(app)}?${query}` : boardPath(app);
}

/**
 * One column per day, one cell per report coloured by where that report's
 * issue has got to. Cells fill from the bottom; when a day has more reports
 * than rows the top cell stands for the rest and says so in its tooltip.
 */
function statsTile(stats: BoardStats): string {
  const columns = stats.days
    .map((d) => {
      const date = formatDate(`${d.day}T00:00:00Z`);
      const label = `${date}: ${d.count} ${d.count === 1 ? 'report' : 'reports'}`;
      const cells: string[] = [];
      for (let row = ACTIVITY_ROWS - 1; row >= 0; row--) {
        const status = d.cells[row];
        if (!status) {
          cells.push('<i class="c"></i>');
        } else if (row === ACTIVITY_ROWS - 1 && d.count > ACTIVITY_ROWS) {
          cells.push(`<i class="c s-${status} more" title="${escapeHTML(`${label} (+${d.count - ACTIVITY_ROWS} more)`)}"></i>`);
        } else {
          cells.push(`<i class="c s-${status}" title="${escapeHTML(`${date}: ${STATUS_LABELS[status]}`)}"></i>`);
        }
      }
      return `<span class="day" title="${escapeHTML(label)}">${cells.join('')}</span>`;
    })
    .join('');
  return `<aside class="stats" aria-label="Activity">
  <div class="top"><strong>${stats.reportsInWindow} ${stats.reportsInWindow === 1 ? 'report' : 'reports'}</strong><span>over ${ACTIVITY_DAYS} days</span></div>
  <div class="activity">${columns}</div>
  <div class="bottom"><span class="s-reported"><b>${stats.byStatus.reported}</b> Reported</span><span class="s-in_progress"><b>${stats.byStatus.in_progress}</b> In progress</span><span class="s-complete"><b>${stats.byStatus.complete}</b> Completed</span></div>
</aside>`;
}

function siteHeader(model: BoardPageModel): string {
  const { app } = model;
  const crumb = app
    ? `<p class="crumb"><a href="/board">All apps</a> / ${escapeHTML(app.name)}</p>`
    : `<p class="crumb">Feedback</p>`;
  const title = app ? escapeHTML(app.name) : 'Across our apps';
  const sub = app ? 'Issues and ideas people have sent in, and where each one stands.' : 'Issues and ideas from every app, and where each one stands.';
  return `<header class="site">
  <div>${crumb}<h1>${title}</h1><p class="sub">${sub}</p>${tabs(app, 'board', model.filters.app)}</div>
  ${statsTile(model.stats)}
</header>`;
}

function toolbar(model: BoardPageModel): string {
  const { app, apps, filters } = model;
  const appSelect = app
    ? ''
    : `<select name="app" aria-label="App" onchange="this.form.submit()"><option value="">All apps</option>${apps
        .map((a) => `<option value="${escapeHTML(a.id)}"${filters.app === a.id ? ' selected' : ''}>${escapeHTML(a.name)}</option>`)
        .join('')}</select>`;
  const statusSelect = `<select name="status" aria-label="Status" onchange="this.form.submit()"><option value="">All statuses</option>${ISSUE_STATUSES.map(
    (s) => `<option value="${s}"${filters.status === s ? ' selected' : ''}>${escapeHTML(STATUS_LABELS[s])}</option>`,
  ).join('')}</select>`;
  return `<div class="toolbar">
  <nav class="seg" aria-label="View">
    <a href="${href(app, filters, { view: 'columns', status: '', offset: 0 })}"${filters.view === 'columns' ? ' class="on"' : ''}>Board</a>
    <a href="${href(app, filters, { view: 'list', offset: 0 })}"${filters.view === 'list' ? ' class="on"' : ''}>List</a>
  </nav>
  <form method="get" action="${boardPath(app)}">
    ${filters.view === 'list' ? '<input type="hidden" name="view" value="list">' : ''}
    ${appSelect}
    ${statusSelect}
    <input type="search" name="q" placeholder="Search titles" value="${escapeHTML(filters.q)}">
    <button type="submit">Search</button>
  </form>
</div>`;
}

function card(issue: BoardIssue, showApp: boolean, showRelease: boolean): string {
  const kind = issue.kind ? ` · ${KIND_LABELS[issue.kind]}` : '';
  const left = showApp ? escapeHTML(issue.appName) : formatDate(issue.updatedAt);
  let right = '';
  if (showRelease && issue.release) right = escapeHTML(issue.release);
  else if (showApp) right = formatDate(issue.updatedAt);
  else if (issue.follows > 0) right = `${issue.follows} following`;
  return `<a class="card" href="${issuePath(issue)}">
  <div class="card-top"><span>#${issue.number}${kind}</span><span class="votes" title="${issue.votes} ${issue.votes === 1 ? 'vote' : 'votes'}">&#9650; ${issue.votes}</span></div>
  <div class="card-title">${escapeHTML(issue.title)}</div>
  <div class="card-meta"><span>${left}</span><span>${right}</span></div>
</a>`;
}

function column(status: IssueStatus, data: ColumnData, model: BoardPageModel): string {
  const showApp = model.app === null;
  let body: string;
  if (data.items.length === 0) {
    body = `<p class="empty">Nothing here yet.</p>`;
  } else if (status === 'complete') {
    body = releaseGroups(data, showApp);
  } else {
    body = data.items.map((i) => card(i, showApp, true)).join('');
  }
  const more =
    data.total > data.items.length
      ? `<a class="more" href="${href(model.app, model.filters, { view: 'list', status, offset: 0 })}">View all ${data.total}</a>`
      : '';
  return `<section class="col${data.items.length === 0 ? ' is-empty' : ''}">
  <div class="col-head"><span class="dot s-${status}"></span>${escapeHTML(STATUS_LABELS[status])}<span class="count">${data.total}</span></div>
  ${body}${more}
</section>`;
}

/** Complete column: one collapsible group per release, newest first, unreleased last. */
function releaseGroups(data: ColumnData, showApp: boolean): string {
  const order: (string | null)[] = [];
  const grouped = new Map<string | null, BoardIssue[]>();
  for (const issue of data.items) {
    const key = issue.release;
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(issue);
  }
  const counts = new Map((data.releaseGroups ?? []).map((g) => [g.release, g.count]));
  const keys: (string | null)[] = order.filter((k): k is string => k !== null);
  if (order.includes(null)) keys.push(null);
  return keys
    .map((key) => {
      const items = grouped.get(key)!;
      const count = counts.get(key) ?? items.length;
      const label = key === null ? 'No release assigned' : key;
      return `<details class="release">
  <summary><span class="label">${escapeHTML(label)}</span><span class="n">${count} ${count === 1 ? 'item' : 'items'}</span></summary>
  ${items.map((i) => card(i, showApp, false)).join('')}
</details>`;
    })
    .join('');
}

function listView(model: BoardPageModel): string {
  const { app, filters } = model;
  const list = model.list!;
  const rows =
    list.issues.length === 0
      ? `<p class="empty-page">Nothing matches.</p>`
      : list.issues
          .map(
            (issue) => `<a class="issue" href="${issuePath(issue)}">
  <div class="top"><span class="number">#${issue.number}</span><span class="title">${escapeHTML(issue.title)}</span>${statusBadge(issue.status)}${issue.release ? `<span class="release-tag">${escapeHTML(issue.release)}</span>` : ''}</div>
  <div class="meta">${app ? '' : `${escapeHTML(issue.appName)} · `}${issue.kind ? `${KIND_LABELS[issue.kind]} · ` : ''}&#9650; ${issue.votes} · ${issue.follows} following · Updated ${escapeHTML(formatDate(issue.updatedAt))}</div>
</a>`,
          )
          .join('\n');
  const prev =
    filters.offset > 0
      ? `<a href="${href(app, filters, { offset: Math.max(0, filters.offset - BOARD_PAGE_SIZE) })}">&larr; Previous</a>`
      : '<span></span>';
  const next = list.hasMore ? `<a href="${href(app, filters, { offset: filters.offset + BOARD_PAGE_SIZE })}">Next &rarr;</a>` : '<span></span>';
  const sortBar = `<p class="meta">Sort:
    <a href="${href(app, filters, { sort: 'recent', offset: 0 })}"${filters.sort === 'recent' ? ' style="font-weight:600"' : ''}>Recently updated</a> ·
    <a href="${href(app, filters, { sort: 'top', offset: 0 })}"${filters.sort === 'top' ? ' style="font-weight:600"' : ''}>Most voted</a></p>`;
  return `${sortBar}${rows}<div class="pager">${prev}${next}</div>`;
}

export function renderRoadmapPage(model: RoadmapPageModel): string {
  const { app, apps, selectedApp, lanes } = model;
  const showApp = app === null;
  const crumb = app
    ? `<p class="crumb"><a href="/board">All apps</a> / ${escapeHTML(app.name)}</p>`
    : `<p class="crumb">Feedback</p>`;
  const appSelect = app
    ? ''
    : `<div class="toolbar"><form method="get" action="/roadmap"><select name="app" aria-label="App" onchange="this.form.submit()"><option value="">All apps</option>${apps
        .map((a) => `<option value="${escapeHTML(a.id)}"${selectedApp === a.id ? ' selected' : ''}>${escapeHTML(a.name)}</option>`)
        .join('')}</select></form></div>`;
  const columns = ROADMAP_LANES.map((lane) => {
    const items = lanes[lane];
    const body = items.length === 0 ? `<p class="empty">Nothing here yet.</p>` : items.map((i) => card(i, showApp, true)).join('');
    return `<section class="col${items.length === 0 ? ' is-empty' : ''}">
  <div class="col-head">${escapeHTML(LANE_LABELS[lane])}<span class="lane-hint">${escapeHTML(LANE_HINTS[lane])}</span><span class="count">${items.length}</span></div>
  ${body}
</section>`;
  }).join('');
  // Shipped is derived: roadmap items whose status reached Complete, grouped by release like the board.
  const shipped = model.shipped;
  const shippedBody =
    shipped.length === 0
      ? `<p class="empty">Nothing shipped yet.</p>`
      : releaseGroups({ total: shipped.length, items: shipped }, showApp);
  const shippedColumn = `<section class="col${shipped.length === 0 ? ' is-empty' : ''}">
  <div class="col-head"><span class="dot s-complete"></span>Shipped<span class="lane-hint">Done and in a release</span><span class="count">${shipped.length}</span></div>
  ${shippedBody}
</section>`;
  return layout({
    title: `${app ? `${app.name} · ` : ''}Roadmap`,
    description: app ? `What is planned for ${app.name}.` : 'What is planned across our apps.',
    body: `<header class="site">
  <div>${crumb}<h1>Roadmap</h1><p class="sub">What we're working on now, what comes next, what's on the list, and what has shipped.</p>${tabs(app, 'roadmap', selectedApp)}</div>
</header>
${appSelect}
<div class="columns" style="grid-auto-columns: minmax(240px, 1fr)">${columns}${shippedColumn}</div>`,
  });
}

// MARK: - Timeline page

const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>(['complete', 'closed']);
const MINUTE = 6e4;
const HOUR = 36e5;
const DAY = 864e5;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return 'moments';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function timelineHref(app: AppInfo | null, filters: TimelineFilters, overrides: Partial<TimelineFilters>): string {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (!app && f.app) params.set('app', f.app);
  if (f.status) params.set('status', f.status);
  if (f.q) params.set('q', f.q);
  if (f.span !== 'fit') params.set('span', f.span);
  if (f.offset > 0) params.set('offset', String(f.offset));
  const query = params.toString();
  return query ? `${timelinePath(app)}?${query}` : timelinePath(app);
}

/** Tick positions for the axis, denser as the window shrinks. Day ticks sit on UTC midnights. */
function axisTicks(start: number, end: number): { pct: number; label: string }[] {
  const length = end - start;
  let step: number;
  let mode: 'day' | 'hour' | 'minute';
  if (length > 21 * DAY) [step, mode] = [7 * DAY, 'day'];
  else if (length > 2 * DAY) [step, mode] = [DAY, 'day'];
  else if (length > 12 * HOUR) [step, mode] = [6 * HOUR, 'hour'];
  else if (length > 2 * HOUR) [step, mode] = [HOUR, 'hour'];
  else [step, mode] = [10 * MINUTE, 'minute'];

  let first: number;
  if (mode === 'day') {
    const firstMidnight = Math.ceil(start / DAY) * DAY;
    // Weekly ticks count back from the newest midnight so the last one lands near "now".
    const lastMidnight = Math.floor(end / DAY) * DAY;
    first = step === DAY ? firstMidnight : lastMidnight - Math.floor((lastMidnight - firstMidnight) / step) * step;
  } else {
    first = Math.ceil(start / step) * step;
  }

  const ticks: { pct: number; label: string }[] = [];
  for (let t = first; t <= end; t += step) {
    const pct = ((t - start) / length) * 100;
    if (pct < 1.5 || pct > 96) continue;
    const d = new Date(t);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const label =
      mode === 'day'
        ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
        : mode === 'hour'
          ? `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${hh}:00`
          : `${hh}:${mm}`;
    ticks.push({ pct, label });
  }
  return ticks;
}

/** One issue's journey: a bar from first report to now (or to completion), split by status. */
function timelineRow(
  row: { issue: BoardIssue; history: StatusChange[] },
  start: number,
  end: number,
  showApp: boolean,
  ticks: { pct: number }[],
): string {
  const { issue } = row;
  const length = end - start;
  const history = row.history.length > 0 ? row.history : [{ status: issue.status, at: issue.createdAt }];
  const times = history.map((h) => Date.parse(h.at));
  const last = history[history.length - 1]!;
  const terminal = TERMINAL_STATUSES.has(last.status);
  const finish = terminal ? times[times.length - 1]! : end;

  const segments = history
    .map((h, i) => {
      const s0 = times[i]!;
      const s1 = i + 1 < history.length ? times[i + 1]! : terminal ? s0 : end;
      const a = Math.max(s0, start);
      const b = Math.min(s1, end);
      if (b < start || a > end) return '';
      const left = ((a - start) / length) * 100;
      const width = Math.max(0, ((b - a) / length) * 100);
      const isEnd = i === history.length - 1 && terminal;
      const title = isEnd ? `${STATUS_LABELS[h.status]} · ${formatDate(h.at)}` : `${STATUS_LABELS[h.status]} · ${formatDuration(s1 - s0)}`;
      const label = width >= 12 ? escapeHTML(STATUS_LABELS[h.status]) : '';
      const classes = ['bar', `s-${h.status}`, i === 0 ? 'first' : '', i === history.length - 1 ? 'last' : '', isEnd ? 'end' : '']
        .filter(Boolean)
        .join(' ');
      return `<span class="${classes}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHTML(title)}">${label}</span>`;
    })
    .join('');

  const openFor = formatDuration(finish - Date.parse(issue.createdAt));
  const state = !terminal ? `Open for ${openFor}` : last.status === 'complete' ? `Completed in ${openFor}` : `Closed after ${openFor}`;
  const meta = [showApp ? escapeHTML(issue.appName) : null, issue.kind ? KIND_LABELS[issue.kind] : null, state].filter(Boolean).join(' · ');
  const grid = ticks.map((t) => `<i class="grid" style="left:${t.pct.toFixed(3)}%"></i>`).join('');
  return `<div class="tl-row">
  <div class="tl-label"><a href="${issuePath(issue)}"><span class="n">#${issue.number}</span>${escapeHTML(issue.title)}</a><div class="meta">${meta}</div></div>
  <div><div class="track">${grid}<i class="nowline"></i>${segments}</div></div>
</div>`;
}

export function renderTimelinePage(model: TimelinePageModel): string {
  const { app, apps, filters, rows } = model;
  const showApp = app === null;
  const end = model.now;
  const spanDef = TIMELINE_SPANS.find((s) => s.id === filters.span) ?? TIMELINE_SPANS[0]!;
  let start: number;
  if (spanDef.ms !== null) {
    start = end - spanDef.ms;
  } else {
    const created = rows.map((r) => Date.parse(r.issue.createdAt)).filter((n) => Number.isFinite(n));
    start = created.length > 0 ? Math.min(...created) : end - 30 * DAY;
    if (end - start < HOUR) start = end - HOUR;
    start -= (end - start) * 0.02;
  }
  const ticks = axisTicks(start, end);

  const crumb = app
    ? `<p class="crumb"><a href="/board">All apps</a> / ${escapeHTML(app.name)}</p>`
    : `<p class="crumb">Feedback</p>`;
  const appSelect = app
    ? ''
    : `<select name="app" aria-label="App" onchange="this.form.submit()"><option value="">All apps</option>${apps
        .map((a) => `<option value="${escapeHTML(a.id)}"${filters.app === a.id ? ' selected' : ''}>${escapeHTML(a.name)}</option>`)
        .join('')}</select>`;
  const statusSelect = `<select name="status" aria-label="Status" onchange="this.form.submit()"><option value="">All statuses</option>${ISSUE_STATUSES.map(
    (s) => `<option value="${s}"${filters.status === s ? ' selected' : ''}>${escapeHTML(STATUS_LABELS[s])}</option>`,
  ).join('')}</select>`;
  const spans = TIMELINE_SPANS.map(
    (s) => `<a href="${timelineHref(app, filters, { span: s.id, offset: 0 })}"${s.id === filters.span ? ' class="on"' : ''}>${s.label}</a>`,
  ).join('');

  const axis = `<div class="tl-axis">${ticks
    .map((t) => `<span class="tick" style="left:${t.pct.toFixed(3)}%">${escapeHTML(t.label)}</span>`)
    .join('')}<span class="now">Now</span></div>`;
  const body =
    rows.length === 0
      ? `<p class="empty-page">Nothing to show for these filters.</p>`
      : `<div class="tl"><div class="tl-scroll"><div class="tl-grid">
  <div class="tl-head"><div>Issue / idea</div>${axis}</div>
  ${rows.map((r) => timelineRow(r, start, end, showApp, ticks)).join('')}
</div></div></div>`;
  const legend = `<div class="legend">${ISSUE_STATUSES.map((s) => `<span><i class="dot s-${s}"></i>${escapeHTML(STATUS_LABELS[s])}</span>`).join('')}</div>`;
  const prev =
    filters.offset > 0
      ? `<a href="${timelineHref(app, filters, { offset: Math.max(0, filters.offset - TIMELINE_PAGE_SIZE) })}">&larr; Previous</a>`
      : '<span></span>';
  const next = model.hasMore ? `<a href="${timelineHref(app, filters, { offset: filters.offset + TIMELINE_PAGE_SIZE })}">Next &rarr;</a>` : '<span></span>';

  return layout({
    title: `${app ? `${app.name} · ` : ''}Timeline`,
    description: app ? `How each ${app.name} issue has progressed over time.` : 'How each issue has progressed over time, across our apps.',
    body: `<header class="site">
  <div>${crumb}<h1>Timeline</h1><p class="sub">Each issue's journey, from first report to completion.</p>${tabs(app, 'timeline', filters.app)}</div>
</header>
<div class="toolbar">
  <form method="get" action="${timelinePath(app)}">
    ${filters.span !== 'fit' ? `<input type="hidden" name="span" value="${filters.span}">` : ''}
    ${appSelect}
    ${statusSelect}
    <input type="search" name="q" placeholder="Search titles" value="${escapeHTML(filters.q)}">
    <button type="submit">Search</button>
  </form>
</div>
<div class="tl-tools">
  <div class="spans">One screen shows <nav class="seg" aria-label="Time span">${spans}</nav></div>
  <span>${model.total} ${model.total === 1 ? 'issue or idea' : 'issues &amp; ideas'}</span>
</div>
${body}
${legend}
<div class="pager">${prev}${next}</div>`,
  });
}

// MARK: - Progress widget

/**
 * A self-contained card for embedding on an app's own website: headline
 * totals, a status-by-day grid for the last ACTIVITY_DAYS days, and a link
 * to the board. Uses the same embed handshake as the other pages.
 */
export function renderProgressWidget(model: ProgressModel): string {
  const { app, days, grid } = model;
  const rowOrder: IssueStatus[] = ['reported', 'planned', 'in_progress', 'pending', 'testing', 'complete', 'closed'];
  const rows = rowOrder
    .map((status) => {
      const counts = grid[status];
      const max = Math.max(1, ...counts);
      const cells = counts
        .map((n, i) => {
          const day = days[i] ?? '';
          const date = formatDate(`${day}T00:00:00Z`);
          const what = status === 'reported' ? `${n} ${n === 1 ? 'report' : 'reports'}` : `${n} → ${STATUS_LABELS[status]}`;
          const alpha = n === 0 ? 0 : 0.35 + 0.65 * (n / max);
          return `<i class="c${n > 0 ? ` s-${status}` : ''}" style="${n > 0 ? `opacity:${alpha.toFixed(2)}` : ''}" title="${escapeHTML(`${date}: ${what}`)}"></i>`;
        })
        .join('');
      return `<div class="r"><span class="rl">${escapeHTML(STATUS_LABELS[status])}</span><div class="cells">${cells}</div></div>`;
    })
    .join('');
  const dayLabels = days
    .map((day, i) =>
      i % 4 === 0
        ? `<span${i % 8 === 0 ? '' : ' class="alt"'} style="left:${((i + 0.5) / days.length) * 100}%">${escapeHTML(formatDate(`${day}T00:00:00Z`).replace(/ \d{4}$/, ''))}</span>`
        : '',
    )
    .join('');
  const legend = rowOrder.map((s) => `<span><i class="dot s-${s}"></i>${escapeHTML(STATUS_LABELS[s])}</span>`).join('');
  const boardURL = boardPath(app);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(app.name)} · Feedback and progress</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --card: #f5f5f7; --panel: #fff; --line: #e5e5ea; --accent: #0071e3; }
:root[data-theme=light] { color-scheme: light; }
:root[data-theme=dark] { color-scheme: dark; ${DARK_VARS} }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { ${DARK_VARS} } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
html.embedded body { background: transparent; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); padding: 2px; }
.pw { border: 1px solid var(--line); border-radius: 22px; background: var(--panel); padding: clamp(20px, 3vw, 36px); }
.pw-top { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
.pw-top .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); margin: 0 0 8px; }
.pw-top .eyebrow i { width: 7px; height: 7px; border-radius: 50%; background: #15803d; }
.pw-top h2 { margin: 0 0 8px; font-size: clamp(24px, 3vw, 34px); letter-spacing: -.02em; }
.pw-top p { margin: 0; color: var(--muted); font-size: 14px; }
.totals { display: flex; gap: 28px; text-align: right; }
.totals b { display: block; font-size: clamp(26px, 3vw, 36px); line-height: 1.1; letter-spacing: -.02em; }
.totals small { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.totals .s-reported b { color: #8e8e93; } .totals .s-in_progress b { color: #1a56db; } .totals .s-complete b { color: #15803d; }
.explore { display: inline-block; margin-top: 12px; font-weight: 600; color: var(--fg); text-decoration: none; font-size: 14px; }
.explore:hover { text-decoration: underline; }
.right { display: grid; justify-items: end; gap: 4px; }
.grid { margin-top: 24px; }
.dates { position: relative; height: 20px; margin-left: 96px; font-size: 12px; color: var(--muted); }
.dates span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.r { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 0 0; margin-top: 5px; }
.rl { font-size: 13px; color: var(--muted); padding-right: 10px; }
.cells { display: grid; grid-template-columns: repeat(${ACTIVITY_DAYS}, 1fr); gap: 4px; }
.cells .c { display: block; aspect-ratio: 1; border-radius: 5px; background: var(--card); }
.c.s-reported { background: #6e6e73; } .c.s-planned { background: #c9a227; } .c.s-in_progress { background: #1a56db; }
.c.s-pending { background: #b45309; } .c.s-testing { background: #7e22ce; } .c.s-complete { background: #15803d; } .c.s-closed { background: #8e6c7a; }
.pw-foot { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; margin-top: 18px; font-size: 13px; color: var(--muted); }
.pw-foot b { color: var(--fg); }
.legend { display: flex; gap: 14px; flex-wrap: wrap; }
.legend span { display: inline-flex; align-items: center; } .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: var(--muted); }
.dot.s-planned { background: #c9a227; } .dot.s-in_progress { background: #1a56db; } .dot.s-pending { background: #b45309; }
.dot.s-testing { background: #7e22ce; } .dot.s-complete { background: #15803d; } .dot.s-closed { background: #8e6c7a; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--fg); text-decoration: none; margin-left: 14px; }
.brand svg { width: 22px; height: 22px; } .brand .mark-bg { fill: var(--fg); } .brand .mark-fg { fill: var(--bg); }
.brand .words { display: grid; line-height: 1.1; } .brand .words small { font-size: 9px; color: var(--muted); } .brand .words b { font-size: 12px; }
@media (max-width: 640px) { .rl { font-size: 11px; } .r { grid-template-columns: 72px 1fr; } .dates { margin-left: 72px; font-size: 11px; } .dates .alt { display: none; } .cells { gap: 2px; } .cells .c { border-radius: 2px; } .totals { gap: 16px; } }
</style>
<script>${EMBED_SCRIPT}</script>
</head>
<body>
<section class="pw" aria-label="${escapeHTML(app.name)} feedback and progress">
  <div class="pw-top">
    <div>
      <p class="eyebrow"><i></i>Made better, together</p>
      <h2>Feedback and progress.</h2>
      <p>Little fixes, bright ideas, and everything moving forward.</p>
    </div>
    <div class="right">
      <div class="totals">
        <div class="s-reported"><b>${model.byStatus.reported}</b><small><i class="dot"></i>Reported</small></div>
        <div class="s-in_progress"><b>${model.byStatus.in_progress}</b><small><i class="dot s-in_progress"></i>In progress</small></div>
        <div class="s-complete"><b>${model.byStatus.complete}</b><small><i class="dot s-complete"></i>Completed</small></div>
      </div>
      <a class="explore" href="${boardURL}" target="_top">Explore feedback &nearr;</a>
    </div>
  </div>
  <div class="grid">
    <div class="dates">${dayLabels}</div>
    ${rows}
  </div>
  <div class="pw-foot">
    <span><b>${model.reportsInWindow} ${model.reportsInWindow === 1 ? 'report' : 'reports'}</b> over ${ACTIVITY_DAYS} days${brandBadgeSmall()}</span>
    <div class="legend">${legend}</div>
  </div>
</section>
</body>
</html>`;
}

function brandBadgeSmall(): string {
  return `<a class="brand" href="${BRAND.url}" target="_top" aria-label="Powered by ${escapeHTML(BRAND.name)}">${brandMark(22)}<span class="words"><small>Powered by</small><b>${escapeHTML(BRAND.name)}</b></span></a>`;
}

// MARK: - Pages

export function renderBoardPage(model: BoardPageModel): string {
  const { app, filters } = model;
  const content =
    filters.view === 'list' || !model.columns
      ? listView(model)
      : `<div class="columns">${ISSUE_STATUSES.map((s) => column(s, model.columns![s], model)).join('')}</div>`;
  const title = app ? `${app.name} · Feedback board` : 'Feedback board';
  return layout({
    title,
    description: app
      ? `Reported issues and ideas for ${app.name}, with their current status.`
      : 'Reported issues and ideas across our apps, with their current status.',
    body: `${siteHeader(model)}${toolbar(model)}${content}`,
  });
}

export function renderIssue(app: AppInfo, issue: BoardIssue): string {
  return layout({
    narrow: true,
    title: `#${issue.number} ${issue.title} · ${app.name}`,
    description: issue.title,
    body: `<header class="site"><div><p class="crumb"><a href="/board">All apps</a> / <a href="${boardPath(app)}">${escapeHTML(app.name)}</a></p><h1>${escapeHTML(app.name)}</h1></div></header>
<p><a href="${boardPath(app)}">&larr; Back to the board</a></p>
<article class="detail">
  <div class="top"><span class="number">#${issue.number}</span> ${statusBadge(issue.status)}${issue.kind ? ` <span class="badge">${KIND_LABELS[issue.kind]}</span>` : ''}${issue.release ? ` <span class="release-tag">${escapeHTML(issue.release)}</span>` : ''}</div>
  <h2>${escapeHTML(issue.title)}</h2>
  <div class="meta">&#9650; ${issue.votes} ${issue.votes === 1 ? 'vote' : 'votes'} · ${issue.follows} following${issue.roadmapLane ? ` · Roadmap: ${LANE_LABELS[issue.roadmapLane]}` : ''}</div>
  <div class="meta">Reported ${escapeHTML(formatDate(issue.createdAt))} · Updated ${escapeHTML(formatDate(issue.updatedAt))}</div>
  <div class="body">${issue.body.trim() ? paragraphs(issue.body) : '<p class="meta">No further details.</p>'}</div>
</article>`,
  });
}

export function renderNotFound(message: string): string {
  return layout({
    narrow: true,
    title: 'Not found',
    body: `<header class="site"><div><h1>Not found</h1></div></header><p class="empty-page">${escapeHTML(message)}</p><p><a href="/board">&larr; All apps</a></p>`,
  });
}
