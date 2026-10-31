import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ApiError, errors } from './errors';
import { admin } from './routes/admin';
import { attachments, sweepOrphans } from './routes/attachments';
import { attest } from './routes/attest';
import { board } from './routes/board';
import { conversation } from './routes/conversation';
import { engage } from './routes/engage';
import { mine } from './routes/mine';
import { register } from './routes/register';
import { enquiriesAdmin, site } from './routes/site';
import { submit } from './routes/submit';
import type { AppContext, Env } from './env';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // the route itself enforces 5 MiB on the image

const app = new Hono<AppContext>();

// Every request body is capped before any handler reads it: 1 MiB for JSON,
// a little over 5 MiB for the two image upload endpoints.
const jsonLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => errors.payloadTooLarge().toResponse() });
const uploadLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES,
  onError: () => new ApiError(413, 'upload_too_large', 'Images must be 5 MB or smaller.').toResponse(),
});
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isUpload = c.req.method === 'POST' && (path === '/api/attachments' || path === '/admin/api/attachments');
  return (isUpload ? uploadLimit : jsonLimit)(c, next);
});

app.get('/health', (c) => c.json({ ok: true }));

// Client API (bearer installation token).
app.route('/api/register', register);
app.route('/api/attest', attest); // /api/attest/challenge, /api/attest/register
app.route('/api/submit', submit);
app.route('/api/mine', mine);
app.route('/api/attachments', attachments);
app.route('/api', engage); //        /api/vote, /api/follow
app.route('/api', conversation); //  /api/conversation, /api/reply, /api/conversation-read, /api/unread

// Public board and roadmap: HTML pages plus GET /api/board/:appId.
app.route('/', board);

// The Nuke landing page at / and its contact form.
app.route('/', site);

// Developer inbox, behind Cloudflare Access; the enquiries list sits beside it.
app.route('/admin', admin);
app.route('/admin', enquiriesAdmin);

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404),
);

app.onError((err, c) => {
  if (err instanceof ApiError) return err.toResponse();
  console.error('Unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

export default {
  fetch: app.fetch,
  /** Nightly: drop uploads that were never attached to a report or message. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      sweepOrphans(env).then((count) => {
        if (count > 0) console.log(`Swept ${count} orphaned attachment(s)`);
      }),
    );
  },
};
