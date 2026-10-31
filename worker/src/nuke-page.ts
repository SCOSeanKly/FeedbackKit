import { BRAND, brandMark, escapeHTML, layout } from './html';

/**
 * The Nuke landing page: what the suite is, how it works, and a contact form
 * for developers who would like to use it. Server-rendered, no JavaScript
 * beyond the shared embed handshake; the form posts normally.
 */

export interface Enquiry {
  id: string;
  name: string;
  email: string;
  app: string | null;
  message: string;
  handled: number;
  created_at: string;
}

const FEATURES: { n: string; kicker: string; title: string; body: string; points: string[] }[] = [
  {
    n: '01',
    kicker: 'Collect',
    title: 'A private inbox for every report.',
    body: 'People send bugs and ideas from inside your app in a few taps, with screenshots and an opt-in diagnostics summary. No account, no email address, nothing to sign up for.',
    points: ['Drafts survive a lost connection and never double-post', 'Up to four screenshots, downscaled on device', 'App version, OS and device attached only if the person agrees'],
  },
  {
    n: '02',
    kicker: 'Review',
    title: 'You decide what goes public.',
    body: 'Reports land in an admin protected by Cloudflare Access. Publish a cleaned-up copy, dismiss, or merge duplicates so votes and followers add up on one issue.',
    points: ['Seven statuses from Reported to Complete', 'Release tags group finished work by version', 'Edits are version-locked so two tabs never clobber each other'],
  },
  {
    n: '03',
    kicker: 'Share',
    title: 'A board people can follow.',
    body: 'Every published issue has a public page with votes and follows. The board shows status columns, the roadmap shows Now, Next, Later and Shipped, and the timeline draws each issue\'s journey.',
    points: ['Server-rendered, fast, readable without JavaScript', 'Light and dark, or pinned to match your site', 'One instance serves all of your apps'],
  },
  {
    n: '04',
    kicker: 'Converse',
    title: 'Talk to reporters privately.',
    body: 'Ask for more detail or say thanks in a Messages-style thread inside the app. Images go both ways, and unread replies are tracked per conversation.',
    points: ['Threads stay private to the reporter and you', 'Reply from the admin with screenshots of your own', 'Reporters see status changes under My Reports'],
  },
  {
    n: '05',
    kicker: 'Trust',
    title: 'Genuine devices only.',
    body: 'App Attest proves a report came from your real app on a real device, and every write is signed. Rate limits, body caps and idempotent requests keep abuse boring.',
    points: ['Secure Enclave keys, verified against Apple\'s root', 'Images served only to their owner and to you', 'No analytics, no third-party services'],
  },
  {
    n: '06',
    kicker: 'Embed',
    title: 'Your site, your branding.',
    body: 'Frame the board or the progress card on your own website. The page hides its header, reports its height and takes the colour scheme you tell it.',
    points: ['A 31-day "feedback and progress" card for your home page', 'Fifteen lines of host JavaScript, no build step', 'A small "Powered by Nuke" badge and nothing else of ours'],
  },
];

const PAGE_CSS = `
.nk-hero { padding: 24px 0 36px; max-width: 760px; }
.nk-hero .mark { width: 56px; height: 56px; margin-bottom: 18px; } .nk-hero .mark .mark-bg { fill: var(--fg); } .nk-hero .mark .mark-fg { fill: var(--bg); }
.nk-hero .kicker { font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
.nk-hero h1 { font-size: clamp(34px, 5vw, 56px); line-height: 1.05; letter-spacing: -.03em; margin: 0 0 16px; }
.nk-hero .lede { font-size: 18px; color: var(--muted); margin: 0 0 24px; max-width: 60ch; }
.nk-cta { display: flex; gap: 10px; flex-wrap: wrap; }
.nk-cta a { display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px; border-radius: 999px; font-weight: 600; text-decoration: none; border: 1px solid var(--line); color: var(--fg); background: var(--card); }
.nk-cta a.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.nk-feats { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-top: 12px; }
.nk-feat { background: var(--card); border-radius: 18px; padding: 22px; }
.nk-feat .n { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.nk-feat .n b { color: var(--fg); margin-left: 8px; font-weight: 600; }
.nk-feat h2 { font-size: 20px; letter-spacing: -.02em; margin: 10px 0 8px; }
.nk-feat p { margin: 0 0 12px; color: var(--muted); font-size: 15px; }
.nk-feat ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; } .nk-feat li { margin: 4px 0; }
.nk-built { margin-top: 40px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.nk-built div { border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; font-size: 14px; color: var(--muted); }
.nk-built b { display: block; color: var(--fg); margin-bottom: 4px; font-size: 15px; }
.nk-section-head { margin: 44px 0 14px; } .nk-section-head h2 { font-size: 26px; letter-spacing: -.02em; margin: 0 0 6px; } .nk-section-head p { margin: 0; color: var(--muted); }
.nk-contact { background: var(--card); border-radius: 18px; padding: 24px; max-width: 720px; }
.nk-contact form { display: grid; gap: 12px; }
.nk-contact .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.nk-contact label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); font-weight: 600; }
.nk-contact input, .nk-contact textarea { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; width: 100%; }
.nk-contact textarea { min-height: 140px; resize: vertical; }
.nk-contact button { justify-self: start; font: inherit; font-weight: 600; padding: 11px 18px; border-radius: 999px; border: 0; background: var(--fg); color: var(--bg); cursor: pointer; }
.nk-contact .hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.nk-note { padding: 12px 14px; border-radius: 10px; font-size: 14px; margin-bottom: 4px; }
.nk-note.ok { background: #e6f7ee; color: #15803d; } .nk-note.err { background: #fdecec; color: #b42318; }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) .nk-note.ok, :root:not([data-theme=light]) .nk-note.err { background: var(--panel); } }
@media (max-width: 640px) { .nk-contact .row { grid-template-columns: 1fr; } }
.nk-enq { border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; background: var(--panel); }
.nk-enq.done { opacity: .6; }
.nk-enq .top { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.nk-enq .top b { font-size: 16px; } .nk-enq .top span { color: var(--muted); font-size: 13px; }
.nk-enq .msg { margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.nk-enq form { display: inline; } .nk-enq button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
`;

const ERROR_TEXT: Record<string, string> = {
  name: 'Please add your name.',
  email: 'That email address does not look right.',
  message: 'Tell us a little more: at least ten characters.',
};

export function renderNukePage(model: { sent: boolean; error: string | null; appCount: number }): string {
  const features = FEATURES.map(
    (f) => `<article class="nk-feat">
  <div class="n">${f.n}<b>${escapeHTML(f.kicker)}</b></div>
  <h2>${escapeHTML(f.title)}</h2>
  <p>${escapeHTML(f.body)}</p>
  <ul>${f.points.map((p) => `<li>${escapeHTML(p)}</li>`).join('')}</ul>
</article>`,
  ).join('');

  const note = model.sent
    ? `<div class="nk-note ok" role="status">Thanks, your message is in. We read every enquiry and reply by email.</div>`
    : model.error && ERROR_TEXT[model.error]
      ? `<div class="nk-note err" role="alert">${escapeHTML(ERROR_TEXT[model.error]!)}</div>`
      : '';

  return layout({
    title: `${BRAND.name} · In-app feedback for iOS apps`,
    description: 'Nuke is a self-hosted feedback suite for iOS apps: a private inbox, a public board, roadmap and timeline, and a drop-in SwiftUI kit.',
    footerNote: `${BRAND.name} is made by Show Creative. Public boards: NuKey and friends at /board.`,
    body: `<style>${PAGE_CSS}</style>
<script>
// This page is a destination, not a widget: if it ends up inside someone's
// frame (e.g. via the badge on an embedded board), take over the window so
// in-page links and the form behave.
(function () { try { if (window.self !== window.top) window.top.location.href = window.location.href; } catch (e) {} })();
</script>
<section class="nk-hero">
  <div class="mark">${brandMark(56)}</div>
  <p class="kicker">${escapeHTML(BRAND.name)} · Feedback, from inside the app</p>
  <h1>Listen closely.<br>Ship visibly.</h1>
  <p class="lede">${escapeHTML(BRAND.name)} is a self-hosted feedback suite for iOS apps: a private inbox, a public board with roadmap and timeline, private conversations with reporters, and a drop-in SwiftUI kit. Built by Show Creative for our own apps${model.appCount > 1 ? ` (${model.appCount} of them run on this instance)` : ''}, and available to other developers.</p>
  <div class="nk-cta"><a class="primary" href="#contact">Get in touch</a><a href="/board/nukey">See it live &rarr;</a></div>
</section>

<div class="nk-feats">${features}</div>

<div class="nk-section-head"><h2>How it's built.</h2><p>Small, boring infrastructure that you can run yourself.</p></div>
<div class="nk-built">
  <div><b>Cloudflare Worker + D1 + R2</b>One Worker, one SQLite database and one bucket serve every app. Fits in the free tier for a long time.</div>
  <div><b>Swift package, iOS 17+</b>A FeedbackClient actor and four SwiftUI views. System fonts and colours, inherits your tint, no dependencies.</div>
  <div><b>Cloudflare Access for the admin</b>Your identity provider, your allowlist. The Worker verifies the token on every admin request.</div>
  <div><b>Yours to host, or hosted for you</b>Deploy it to your own account, or ask about a managed instance under your own domain.</div>
</div>

<div class="nk-section-head" id="contact"><h2>Interested in using ${escapeHTML(BRAND.name)}?</h2><p>Tell us about your app and how you would like to use it. We reply by email, usually within a day or two.</p></div>
<section class="nk-contact">
  ${note}
  <form method="post" action="/contact">
    <div class="row">
      <label>Name<input name="name" required maxlength="120" autocomplete="name"></label>
      <label>Email<input name="email" type="email" required maxlength="200" autocomplete="email"></label>
    </div>
    <label>App or company (optional)<input name="app" maxlength="120" autocomplete="organization"></label>
    <label>Message<textarea name="message" required minlength="10" maxlength="4000" placeholder="What are you building, and what would you like feedback to do for it?"></textarea></label>
    <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
    <button type="submit">Send enquiry</button>
  </form>
</section>`,
  });
}

export function renderEnquiriesPage(enquiries: Enquiry[]): string {
  const items =
    enquiries.length === 0
      ? `<p class="empty-page">No enquiries yet.</p>`
      : enquiries
          .map(
            (e) => `<article class="nk-enq${e.handled ? ' done' : ''}">
  <div class="top"><b>${escapeHTML(e.name)}</b><span>${escapeHTML(e.created_at.replace('T', ' ').replace('Z', ' UTC'))}</span></div>
  <div><a href="mailto:${escapeHTML(e.email)}?subject=${encodeURIComponent(`Re: ${BRAND.name} enquiry`)}">${escapeHTML(e.email)}</a>${e.app ? ` · ${escapeHTML(e.app)}` : ''}</div>
  <div class="msg">${escapeHTML(e.message)}</div>
  <form method="post" action="/admin/enquiries/${escapeHTML(e.id)}/handled"><button type="submit">${e.handled ? 'Mark as new' : 'Mark as handled'}</button></form>
</article>`,
          )
          .join('');
  return layout({
    narrow: true,
    title: 'Enquiries · Admin',
    footerNote: 'Visible to signed-in admins only.',
    body: `<style>${PAGE_CSS}</style>
<header class="site"><div><p class="crumb"><a href="/admin">Admin</a> / Enquiries</p><h1>Enquiries</h1><p class="sub">Messages from the contact form on the landing page. Unhandled first.</p></div></header>
${items}`,
  });
}
