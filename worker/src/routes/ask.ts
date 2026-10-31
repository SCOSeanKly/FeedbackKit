import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAdmin } from '../access';
import {
  DEFAULT_MODEL,
  MAX_ANSWER_TOKENS,
  MAX_QUESTION_CHARS,
  buildSystemPrompt,
  looksLikeAbuse,
  parseOrigins,
  parseReply,
  sanitiseHistory,
} from '../ask-core';
import { resolveInstallation, requireInstallation } from '../auth';
import { sha256Hex } from '../crypto';
import { ApiError, errors } from '../errors';
import { clientIP, enforceLimit } from '../ratelimit';
import { readJSONObject, requireString, scalarLength } from '../validation';
import type { AppContext } from '../env';

/**
 * Ask: an in-app helper that answers "how do I do X?" from the app's own knowledge.
 *
 * Not trained. Each question sends the app's whole knowledge text to Claude as a
 * cached system prompt (see ask-core.ts for the prompt). Every app registered in
 * `apps` can have one; behaviour, limits and knowledge live in ask_* tables.
 *
 *   Installation (bearer token, the strong route — App Attest applies when enabled)
 *     GET   /api/ask/config                       { enabled, name, suggestions }
 *     POST  /api/ask                              { question, history? } -> { answer, guide, guideTitle, logId }
 *     POST  /api/ask/feedback                     { logId, helpful }
 *
 *   Website visitors (no token; origin allow-list + per-IP burst limit + a smaller daily cap)
 *     GET   /api/ask/web/:app/config
 *     POST  /api/ask/web/:app                     same body and reply as the app route
 *     POST  /api/ask/web/:app/feedback
 *
 *   Publishing (Bearer ASK_PUBLISH_TOKEN — for the knowledge CLI)
 *     GET   /api/ask/publish/:app/knowledge       { version, chars, guides }
 *     POST  /api/ask/publish/:app/knowledge       { body, guides } -> { version }
 *     PUT   /api/ask/publish/:app/config          { enabled?, productName?, ... }
 *
 *   Admin (Cloudflare Access)
 *     GET   /admin/api/ask/:app/log?helpful&offset
 *     GET   /admin/api/ask/:app/usage?days
 */
export const ask = new Hono<AppContext>();
export const askAdmin = new Hono<AppContext>();

const KEEP_KNOWLEDGE_VERSIONS = 5;
const MAX_KNOWLEDGE_CHARS = 600_000;
const LOG_PAGE_SIZE = 50;

interface ConfigRow {
  app_id: string;
  enabled: number;
  assistant_name: string;
  product_name: string;
  description: string;
  extra_rules: string;
  support_hint: string;
  suggestions_json: string;
  model: string;
  daily_cap: number;
  web_daily_cap: number;
  per_install_hour: number;
  per_install_day: number;
  web_origins: string;
}

interface KnowledgeRow {
  version: number;
  body: string;
  guides_json: string;
}

type Source = 'app' | 'web';

const askError = (status: 404 | 429 | 502 | 503, code: string, message: string, headers: Record<string, string> = {}) =>
  new ApiError(status, code, message, headers);

async function loadConfig(c: Context<AppContext>, appId: string): Promise<ConfigRow> {
  const row = await c.env.DB.prepare('SELECT * FROM ask_config WHERE app_id = ?').bind(appId).first<ConfigRow>();
  if (!row || row.enabled !== 1) throw askError(404, 'ask_disabled', 'The helper is not available for this app.');
  return row;
}

function suggestionsOf(config: ConfigRow): string[] {
  try {
    const parsed: unknown = JSON.parse(config.suggestions_json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

const configJSON = (config: ConfigRow) => ({
  enabled: true,
  name: config.assistant_name,
  suggestions: suggestionsOf(config),
});

// ── Answering ──────────────────────────────────────────────────────────────

interface AnswerInput {
  appId: string;
  installationId: string | null;
  source: Source;
  /** Rate-limit key for the burst limiter: the installation id, or the caller's IP on the web. */
  burstKey: string;
  evalRun: boolean;
}

async function answerQuestion(c: Context<AppContext>, input: AnswerInput, body: Record<string, unknown>) {
  const env = c.env;
  const config = await loadConfig(c, input.appId);

  const question = requireString(body, 'question').trim();
  if (!question) throw errors.badRequest('empty_question', 'Type a question first.');
  if (scalarLength(question) > MAX_QUESTION_CHARS) {
    throw errors.badRequest('question_too_long', `Please keep questions under ${MAX_QUESTION_CHARS} characters.`);
  }
  if (looksLikeAbuse(question)) {
    return {
      answer: `I can only help with using ${config.product_name}. What would you like to do?`,
      guide: null,
      guideTitle: null,
      logId: null,
    };
  }

  const knowledge = await env.DB.prepare(
    'SELECT version, body, guides_json FROM ask_knowledge WHERE app_id = ? ORDER BY version DESC LIMIT 1',
  )
    .bind(input.appId)
    .first<KnowledgeRow>();
  if (!knowledge) throw askError(404, 'ask_no_knowledge', 'The helper has nothing to go on yet.');
  if (!env.ANTHROPIC_API_KEY) throw askError(503, 'ask_unavailable', 'The helper is not set up yet.');

  const day = new Date().toISOString().slice(0, 10);

  if (!input.evalRun) {
    // Burst limit at the edge, then the per-installation hour and day from the log,
    // then the app-wide daily cap for this source.
    const burst = input.source === 'app' ? env.ASK_INSTALLATION_LIMIT : env.ASK_IP_LIMIT;
    if (burst) await enforceLimit(burst, input.burstKey);

    if (input.installationId) {
      const since = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, 'Z');
      const counts = await env.DB.prepare(
        `SELECT SUM(created_at > ?) AS hour, COUNT(*) AS day FROM ask_log
         WHERE installation_id = ? AND created_at > ?`,
      )
        .bind(since(3600_000), input.installationId, since(86_400_000))
        .first<{ hour: number | null; day: number }>();
      if ((counts?.hour ?? 0) >= config.per_install_hour) {
        throw askError(429, 'ask_hour_limit', 'That is a lot of questions in an hour. Please try again a little later.', {
          'Retry-After': '3600',
        });
      }
      if ((counts?.day ?? 0) >= config.per_install_day) {
        throw askError(429, 'ask_day_limit', 'Daily question limit reached. Please try again tomorrow.', {
          'Retry-After': '86400',
        });
      }
    }

    const used = await env.DB.prepare('SELECT questions FROM ask_usage WHERE app_id = ? AND day = ? AND source = ?')
      .bind(input.appId, day, input.source)
      .first<{ questions: number }>();
    const cap = input.source === 'app' ? config.daily_cap : config.web_daily_cap;
    if ((used?.questions ?? 0) >= cap) {
      throw askError(429, 'ask_busy', 'The helper is very busy today. Please try again tomorrow.', {
        'Retry-After': '3600',
      });
    }
  }

  // Counted before the call so a hung request still counts against the cap.
  await env.DB.prepare(
    `INSERT INTO ask_usage (app_id, day, source, questions) VALUES (?, ?, ?, 1)
     ON CONFLICT(app_id, day, source) DO UPDATE SET questions = questions + 1`,
  )
    .bind(input.appId, day, input.source)
    .run();

  let guides: Record<string, string> = {};
  try {
    guides = JSON.parse(knowledge.guides_json) as Record<string, string>;
  } catch {
    guides = {};
  }
  const slugs = Object.keys(guides);
  const system = buildSystemPrompt(
    {
      productName: config.product_name,
      assistantName: config.assistant_name,
      description: config.description,
      extraRules: config.extra_rules,
      supportHint: config.support_hint,
    },
    knowledge.body,
    slugs,
  );

  const history = sanitiseHistory(body.history);
  let upstream: Response;
  try {
    upstream = await fetch(`${env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        max_tokens: MAX_ANSWER_TOKENS,
        // Cached: the knowledge is tens of thousands of tokens, so a conversation pays full price once.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [...history, { role: 'user', content: question }],
      }),
    });
  } catch (err) {
    console.error('ask: anthropic unreachable', err);
    throw askError(502, 'ask_upstream', 'The helper is busy right now. Please try again in a moment.');
  }
  if (!upstream.ok) {
    console.error('ask: anthropic error', upstream.status, await upstream.text());
    throw askError(502, 'ask_upstream', 'The helper is busy right now. Please try again in a moment.');
  }

  const data = (await upstream.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  const raw = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  const parsed = parseReply(raw, new Set(slugs));
  const answer =
    parsed.answer ||
    `I couldn't find a good answer to that. Try rephrasing, or use ${config.support_hint} and the developer will reply.`;

  const usage = data.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  let logId: string | null = null;
  if (!input.evalRun) {
    logId = crypto.randomUUID();
    c.executionCtx.waitUntil(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ask_log (id, app_id, installation_id, source, question, answer, guide, knowledge_version,
                                input_tokens, output_tokens, cache_read_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          logId, input.appId, input.installationId, input.source, question, answer, parsed.guide,
          knowledge.version, inputTokens, outputTokens, cacheRead,
        ),
        env.DB.prepare(
          `UPDATE ask_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
                                cache_read_tokens = cache_read_tokens + ?
           WHERE app_id = ? AND day = ? AND source = ?`,
        ).bind(inputTokens, outputTokens, cacheRead, input.appId, day, input.source),
      ]),
    );
  }

  return {
    answer,
    guide: parsed.guide,
    guideTitle: parsed.guide ? (guides[parsed.guide] ?? null) : null,
    logId,
  };
}

async function recordFeedback(c: Context<AppContext>, source: Source, installationId: string | null, appId: string) {
  const input = await readJSONObject(c);
  const logId = typeof input.logId === 'string' ? input.logId : '';
  if (!/^[0-9a-f-]{36}$/i.test(logId) || typeof input.helpful !== 'boolean') {
    throw errors.badRequest('invalid_feedback', 'logId and helpful are required.');
  }
  // A person can only rate an answer they were given: same app, same source, same installation.
  await c.env.DB.prepare(
    `UPDATE ask_log SET helpful = ?
     WHERE id = ? AND app_id = ? AND source = ? AND COALESCE(installation_id, '') = COALESCE(?, '')`,
  )
    .bind(input.helpful ? 1 : 0, logId, appId, source, installationId)
    .run();
  return c.json({ ok: true });
}

// ── Installation routes ────────────────────────────────────────────────────

ask.get('/config', requireInstallation, async (c) => {
  const config = await loadConfig(c, c.var.installation.appId);
  return c.json(configJSON(config));
});

ask.post('/', requireInstallation, async (c) => {
  const installation = c.var.installation;
  const body = await readJSONObject(c);
  const evalRun = isEvalRequest(c);
  return c.json(
    await answerQuestion(
      c,
      { appId: installation.appId, installationId: installation.id, source: 'app', burstKey: installation.id, evalRun },
      body,
    ),
  );
});

ask.post('/feedback', async (c) => {
  const installation = await resolveInstallation(c);
  if (!installation) throw errors.unauthorized();
  return recordFeedback(c, 'app', installation.id, installation.appId);
});

// ── Website routes ─────────────────────────────────────────────────────────

/** Allowed browser origin for this app's web helper, or throws. Also writes the CORS headers. */
async function webGate(c: Context<AppContext>): Promise<{ appId: string; config: ConfigRow }> {
  const appId = c.req.param('app') ?? '';
  const config = await loadConfig(c, appId);
  const origin = c.req.header('origin') ?? '';
  if (!origin || !parseOrigins(config.web_origins).has(origin.replace(/\/$/, ''))) {
    throw errors.forbidden('This website is not allowed to use the helper.', 'origin_not_allowed');
  }
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  return { appId, config };
}

ask.options('/web/:app/*', async (c) => {
  try {
    await webGate(c);
  } catch {
    return c.body(null, 204);
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  return c.body(null, 204);
});
ask.options('/web/:app', async (c) => {
  try {
    await webGate(c);
  } catch {
    return c.body(null, 204);
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  return c.body(null, 204);
});

ask.get('/web/:app/config', async (c) => {
  const { config } = await webGate(c);
  return c.json(configJSON(config));
});

ask.post('/web/:app', async (c) => {
  const { appId } = await webGate(c);
  const body = await readJSONObject(c);
  return c.json(
    await answerQuestion(
      c,
      { appId, installationId: null, source: 'web', burstKey: clientIP(c), evalRun: isEvalRequest(c) },
      body,
    ),
  );
});

ask.post('/web/:app/feedback', async (c) => {
  const { appId } = await webGate(c);
  return recordFeedback(c, 'web', null, appId);
});

/** The test runner's bypass: only exists when ASK_EVAL_TOKEN is set, and only for the exact token. */
function isEvalRequest(c: Context<AppContext>): boolean {
  const token = c.env.ASK_EVAL_TOKEN;
  const sent = c.req.header('x-eval-token');
  return !!token && !!sent && sent === token;
}

// ── Publishing (CLI) ───────────────────────────────────────────────────────

async function requirePublishToken(c: Context<AppContext>): Promise<void> {
  const expected = c.env.ASK_PUBLISH_TOKEN;
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  // Compare hashes so the comparison time does not depend on how much of the token matched.
  if (!expected || !match || (await sha256Hex(match[1]!)) !== (await sha256Hex(expected))) {
    throw errors.unauthorized();
  }
}

async function requireKnownApp(c: Context<AppContext>, appId: string): Promise<void> {
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appId).first();
  if (!app) throw errors.notFound('unknown_app', 'No app with that id is registered.');
}

ask.get('/publish/:app/knowledge', async (c) => {
  await requirePublishToken(c);
  const appId = c.req.param('app');
  const row = await c.env.DB.prepare(
    'SELECT version, length(body) AS chars, guides_json, created_at FROM ask_knowledge WHERE app_id = ? ORDER BY version DESC LIMIT 1',
  )
    .bind(appId)
    .first<{ version: number; chars: number; guides_json: string; created_at: string }>();
  if (!row) return c.json({ version: 0, chars: 0, guides: 0 });
  return c.json({
    version: row.version,
    chars: row.chars,
    guides: Object.keys(JSON.parse(row.guides_json) as object).length,
    publishedAt: row.created_at,
  });
});

ask.post('/publish/:app/knowledge', async (c) => {
  await requirePublishToken(c);
  const appId = c.req.param('app');
  await requireKnownApp(c, appId);
  const input = await readJSONObject(c);
  const text = requireString(input, 'body');
  if (text.trim().length < 200 || text.length > MAX_KNOWLEDGE_CHARS) {
    throw errors.badRequest('invalid_knowledge', `body must be 200 to ${MAX_KNOWLEDGE_CHARS} characters.`);
  }
  const guidesInput = input.guides;
  const guides: Record<string, string> = {};
  if (guidesInput && typeof guidesInput === 'object' && !Array.isArray(guidesInput)) {
    for (const [slug, title] of Object.entries(guidesInput)) {
      if (/^[a-z0-9-]{1,64}$/.test(slug) && typeof title === 'string') guides[slug] = title.slice(0, 160);
    }
  }

  const latest = await c.env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM ask_knowledge WHERE app_id = ?')
    .bind(appId)
    .first<{ v: number }>();
  const version = (latest?.v ?? 0) + 1;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ask_knowledge (app_id, version, body, guides_json) VALUES (?, ?, ?, ?)').bind(
      appId, version, text, JSON.stringify(guides),
    ),
    c.env.DB.prepare('DELETE FROM ask_knowledge WHERE app_id = ? AND version <= ?').bind(
      appId, version - KEEP_KNOWLEDGE_VERSIONS,
    ),
  ]);
  return c.json({ version, chars: text.length, guides: Object.keys(guides).length }, 201);
});

/** Optional string field: absent leaves the column alone (null), present must be a string. */
function optString(input: Record<string, unknown>, key: string, max: number): string | null {
  const value = input[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw errors.badRequest('invalid_field', `Field "${key}" must be a string of at most ${max} characters.`);
  }
  return value;
}

function optInt(input: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const value = input[key];
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw errors.badRequest('invalid_field', `Field "${key}" must be an integer from ${min} to ${max}.`);
  }
  return value;
}

ask.put('/publish/:app/config', async (c) => {
  await requirePublishToken(c);
  const appId = c.req.param('app');
  await requireKnownApp(c, appId);
  const input = await readJSONObject(c);

  const enabled = input.enabled === undefined ? null : input.enabled === true ? 1 : 0;
  const suggestions =
    input.suggestions === undefined
      ? null
      : Array.isArray(input.suggestions) && input.suggestions.every((s) => typeof s === 'string' && s.length <= 120)
        ? JSON.stringify(input.suggestions.slice(0, 8))
        : (() => {
            throw errors.badRequest('invalid_field', 'suggestions must be up to 8 short strings.');
          })();
  const origins =
    input.webOrigins === undefined
      ? null
      : Array.isArray(input.webOrigins) && input.webOrigins.every((s) => typeof s === 'string' && /^https?:\/\/[^\s,]+$/.test(s))
        ? (input.webOrigins as string[]).join(',')
        : (() => {
            throw errors.badRequest('invalid_field', 'webOrigins must be an array of http(s) origins.');
          })();

  const fields = {
    enabled,
    assistant_name: optString(input, 'assistantName', 60),
    product_name: optString(input, 'productName', 80),
    description: optString(input, 'description', 300),
    extra_rules: optString(input, 'extraRules', 4000),
    support_hint: optString(input, 'supportHint', 200),
    suggestions_json: suggestions,
    model: optString(input, 'model', 80),
    daily_cap: optInt(input, 'dailyCap', 0, 1_000_000),
    web_daily_cap: optInt(input, 'webDailyCap', 0, 1_000_000),
    per_install_hour: optInt(input, 'perInstallHour', 0, 10_000),
    per_install_day: optInt(input, 'perInstallDay', 0, 100_000),
    web_origins: origins,
  };

  const existing = await c.env.DB.prepare('SELECT app_id FROM ask_config WHERE app_id = ?').bind(appId).first();
  if (!existing && !fields.product_name) {
    throw errors.badRequest('missing_product_name', 'productName is required the first time an app is configured.');
  }
  if (!existing) {
    await c.env.DB.prepare('INSERT INTO ask_config (app_id, product_name) VALUES (?, ?)')
      .bind(appId, fields.product_name)
      .run();
  }
  const sets = Object.entries(fields).filter(([, v]) => v !== null);
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE ask_config SET ${sets.map(([k]) => `${k} = ?`).join(', ')},
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE app_id = ?`,
    )
      .bind(...sets.map(([, v]) => v), appId)
      .run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM ask_config WHERE app_id = ?').bind(appId).first<ConfigRow>();
  return c.json({ ok: true, config: row });
});

// ── Admin reads ────────────────────────────────────────────────────────────

askAdmin.use('*', requireAdmin);

askAdmin.get('/api/ask/:app/log', async (c) => {
  const appId = c.req.param('app');
  const helpful = c.req.query('helpful');
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const filter = helpful === '0' ? 'AND helpful = 0' : helpful === '1' ? 'AND helpful = 1' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, source, question, answer, guide, helpful, knowledge_version AS knowledgeVersion,
            input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
            created_at AS createdAt
     FROM ask_log WHERE app_id = ? ${filter} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(appId, LOG_PAGE_SIZE, offset)
    .all();
  return c.json({ entries: results, nextOffset: results.length === LOG_PAGE_SIZE ? offset + LOG_PAGE_SIZE : null });
});

askAdmin.get('/api/ask/:app/usage', async (c) => {
  const appId = c.req.param('app');
  const days = Math.min(90, Math.max(1, parseInt(c.req.query('days') ?? '30', 10) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT day, source, questions, input_tokens AS inputTokens, output_tokens AS outputTokens,
            cache_read_tokens AS cacheReadTokens
     FROM ask_usage WHERE app_id = ? AND day >= ? ORDER BY day DESC, source`,
  )
    .bind(appId, since)
    .all();
  const rated = await c.env.DB.prepare(
    `SELECT SUM(helpful = 1) AS up, SUM(helpful = 0) AS down, COUNT(*) AS total
     FROM ask_log WHERE app_id = ? AND created_at >= ?`,
  )
    .bind(appId, since)
    .first();
  return c.json({ usage: results, ratings: rated });
});
