import { Hono } from 'hono';
import { requireAdmin } from '../access';
import { errors } from '../errors';
import { renderEnquiriesPage, renderNukePage, type Enquiry } from '../nuke-page';
import { clientIP, enforceLimit } from '../ratelimit';
import { scalarLength } from '../validation';
import type { AppContext } from '../env';

/**
 * The Nuke landing page and its contact form.
 *
 *   GET  /            what Nuke is, how it works, and a form for developers
 *                     who would like to use it
 *   POST /contact     form submission -> redirect back with ?sent=1 or ?error=
 *
 * Admin side (Cloudflare Access):
 *   GET  /admin/enquiries                  list, unhandled first
 *   POST /admin/enquiries/:id/handled      toggle the handled flag
 */
export const site = new Hono<AppContext>();
export const enquiriesAdmin = new Hono<AppContext>();

const LIMITS = { name: 120, email: 200, app: 120, messageMin: 10, messageMax: 4000 } as const;

site.get('/', async (c) => {
  const url = new URL(c.req.url);
  const { results } = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM apps').all<{ n: number }>();
  c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  return c.html(
    renderNukePage({
      sent: url.searchParams.get('sent') === '1',
      error: url.searchParams.get('error'),
      appCount: results[0]?.n ?? 0,
    }),
  );
});

site.post('/contact', async (c) => {
  await enforceLimit(c.env.ENQUIRY_IP_LIMIT, clientIP(c));
  const form = await c.req.parseBody();
  const field = (key: string, max: number): string => {
    const raw = form[key];
    const value = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    return [...value].slice(0, max).join('');
  };
  // Honeypot: real people never see this field, bots fill everything.
  if (typeof form['website'] === 'string' && form['website'].trim() !== '') return c.redirect('/?sent=1#contact', 303);

  const name = field('name', LIMITS.name);
  const email = field('email', LIMITS.email);
  const app = field('app', LIMITS.app);
  const messageRaw = typeof form['message'] === 'string' ? form['message'].replace(/\r\n/g, '\n').trim() : '';
  const message = [...messageRaw].slice(0, LIMITS.messageMax).join('');

  if (!name) return c.redirect('/?error=name#contact', 303);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.redirect('/?error=email#contact', 303);
  if (scalarLength(message) < LIMITS.messageMin) return c.redirect('/?error=message#contact', 303);

  await c.env.DB.prepare('INSERT INTO enquiries (id, name, email, app, message) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), name, email, app || null, message)
    .run();
  return c.redirect('/?sent=1#contact', 303);
});

enquiriesAdmin.use('*', requireAdmin);

enquiriesAdmin.get('/enquiries', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM enquiries ORDER BY handled, created_at DESC LIMIT 200').all<Enquiry>();
  c.header('Cache-Control', 'private, no-store');
  return c.html(renderEnquiriesPage(results));
});

enquiriesAdmin.post('/enquiries/:id/handled', async (c) => {
  const result = await c.env.DB.prepare('UPDATE enquiries SET handled = 1 - handled WHERE id = ?').bind(c.req.param('id')).run();
  if (result.meta.changes === 0) throw errors.notFound('unknown_enquiry', 'That enquiry does not exist.');
  return c.redirect('/admin/enquiries', 303);
});
