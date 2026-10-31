/**
 * The developer inbox, served at /admin behind Cloudflare Access.
 *
 * Plain HTML, one inline script, no build step. All data arrives via
 * /admin/api/* and is written into the DOM with textContent or value, never
 * innerHTML, so raw feedback text cannot inject markup.
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Feedback admin</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --card: #f5f5f7; --line: #e5e5ea; --accent: #0071e3; --danger: #d70015; --ok: #248a3d; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #000; --card: #1c1c1e; --line: #3a3a3c; --accent: #2997ff; --danger: #ff453a; --ok: #30d158; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header h1 { font-size: 18px; margin: 0 8px 0 0; }
header nav button { background: none; border: 0; padding: 6px 10px; border-radius: 8px; color: var(--muted); font: inherit; cursor: pointer; }
header nav button.active { background: var(--card); color: var(--fg); font-weight: 600; }
header nav .nav-link { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; color: var(--muted); text-decoration: none; font: inherit; }
header nav .nav-link:hover { color: var(--fg); }
.nav-badge { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: #d9480f; color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
.nav-badge.hidden { display: none; }
header .me { margin-left: auto; color: var(--muted); font-size: 13px; }
select, input, textarea, button { font: inherit; color: var(--fg); }
select, input[type=search], input[type=text], textarea { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
textarea { width: 100%; min-height: 160px; resize: vertical; }
input[type=text] { width: 100%; }
.filters { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.filters input[type=search] { flex: 1 1 180px; }
.hidden { display: none !important; }
.panes { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; min-height: calc(100vh - 110px); }
@media (max-width: 760px) { .panes { grid-template-columns: 1fr; } .detail { border-left: 0; border-top: 1px solid var(--line); } }
.list { border-right: 1px solid var(--line); overflow-y: auto; }
.card { display: block; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 12px 16px; cursor: pointer; }
.card:hover { background: var(--card); }
.card.selected { background: var(--card); box-shadow: inset 3px 0 0 var(--accent); }
.card .t { font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .m { color: var(--muted); font-size: 13px; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--line); }
.badge.k-issue { background: #fde8e8; color: #b42318; } .badge.k-idea { background: #e6f7ee; color: #15803d; } .badge.k-other { background: var(--line); }
@media (prefers-color-scheme: dark) { .badge.k-issue, .badge.k-idea { background: var(--line); color: var(--fg); } }
.detail { padding: 20px 24px; overflow-y: auto; }
.detail h2 { margin: 0 0 4px; font-size: 20px; overflow-wrap: anywhere; }
.detail .meta { color: var(--muted); font-size: 13px; margin-bottom: 14px; display: flex; gap: 10px; flex-wrap: wrap; }
.raw { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--card); padding: 12px 14px; border-radius: 10px; margin: 0 0 20px; font: inherit; }
fieldset { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px 16px; margin: 0 0 16px; }
legend { color: var(--muted); font-size: 13px; padding: 0 6px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; } .row > * { flex: 1 1 160px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
button.primary { background: var(--accent); color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
button.secondary { background: var(--card); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
button.danger { background: none; border: 1px solid var(--danger); color: var(--danger); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.empty { color: var(--muted); padding: 32px 16px; text-align: center; }
.more { display: block; width: 100%; padding: 12px; background: none; border: 0; color: var(--accent); cursor: pointer; }
.linked { list-style: none; padding: 0; margin: 0; } .linked li { padding: 8px 0; border-bottom: 1px solid var(--line); }
.linked button { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; text-align: left; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 10px 16px; border-radius: 10px; font-size: 14px; max-width: 90vw; }
.toast.error { background: var(--danger); color: #fff; }
.count { color: var(--muted); font-weight: normal; }
a { color: var(--accent); }
.badge.unread { background: var(--accent); color: #fff; }
.thread { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.msg { padding: 8px 12px; border-radius: 12px; background: var(--card); max-width: 85%; align-self: flex-start; }
.msg.developer { align-self: flex-end; background: var(--accent); color: #fff; }
.msg .who { font-size: 12px; opacity: .75; margin-bottom: 2px; }
.msg .txt { white-space: pre-wrap; overflow-wrap: anywhere; }
.notice { background: var(--card); border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 8px; margin: 0 0 16px; }
.att { max-width: 240px; max-height: 240px; border-radius: 10px; display: block; margin-top: 6px; cursor: zoom-in; }
.att-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 20px; }
.att-row .att { margin: 0; max-width: 160px; max-height: 160px; }
.thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); }
input[type=number] { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); width: 140px; }
</style>
</head>
<body>
<header>
  <h1>Feedback</h1>
  <select id="app" aria-label="App"></select>
  <nav>
    <button type="button" data-tab="inbox" class="active">Inbox</button>
    <button type="button" data-tab="issues">Issues</button>
    <a href="/admin/enquiries" id="enquiries-link" class="nav-link">Enquiries<span class="nav-badge hidden" id="enquiries-badge"></span></a>
  </nav>
  <span class="me" id="me"></span>
</header>

<section class="filters" id="filters-inbox">
  <select id="inbox-state" aria-label="State">
    <option value="pending">Pending</option>
    <option value="published">Published</option>
    <option value="dismissed">Dismissed</option>
    <option value="all">All</option>
  </select>
  <select id="inbox-kind" aria-label="Kind">
    <option value="">All kinds</option>
    <option value="issue">Issue</option>
    <option value="idea">Idea</option>
    <option value="other">Other</option>
  </select>
  <input id="inbox-q" type="search" placeholder="Search title and body">
</section>

<section class="filters hidden" id="filters-issues">
  <select id="issues-status" aria-label="Status"><option value="">All statuses</option></select>
  <input id="issues-q" type="search" placeholder="Search titles">
</section>

<div class="panes">
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><p class="empty">Select an item.</p></div>
</div>

<div id="toast" class="toast hidden" role="status"></div>

<script>
(function () {
  'use strict';

  var STATUSES = { reported: 'Reported', planned: 'Planned', in_progress: 'In progress', pending: 'Pending', testing: 'Testing', complete: 'Complete', closed: 'Closed' };
  var KINDS = { issue: 'Issue', idea: 'Idea', other: 'Other' };
  var STATES = { pending: 'Pending', published: 'Published', dismissed: 'Dismissed' };

  var state = {
    app: '',
    tab: 'inbox',
    inbox: { state: 'pending', kind: '', q: '', offset: 0, items: [], hasMore: false, selectedId: null },
    issues: { status: '', q: '', offset: 0, items: [], hasMore: false, selectedId: null }
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'value') node.value = value;
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  var toastTimer = null;
  function toast(message, isError) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.className = 'toast hidden'; }, isError ? 6000 : 2500);
  }

  async function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    var response = await fetch(path, init);
    var data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
      var error = new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function formatDate(iso) {
    var date = new Date(iso);
    return isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function badge(text, cls) { return el('span', { class: 'badge ' + (cls || ''), text: text }); }

  function statusSelect(id, selected, includeAll) {
    var select = el('select', { id: id });
    if (includeAll) select.appendChild(el('option', { value: '', text: 'All statuses' }));
    Object.keys(STATUSES).forEach(function (key) {
      var option = el('option', { value: key, text: STATUSES[key] });
      if (key === selected) option.selected = true;
      select.appendChild(option);
    });
    return select;
  }

  // ---- Apps and tabs -------------------------------------------------

  async function loadApps() {
    var data = await api('/admin/api/apps');
    var badge = $('enquiries-badge');
    var unhandled = data.unhandledEnquiries || 0;
    badge.textContent = unhandled > 99 ? '99+' : String(unhandled);
    badge.className = 'nav-badge' + (unhandled ? '' : ' hidden');
    $('enquiries-link').title = unhandled ? unhandled + ' new ' + (unhandled === 1 ? 'enquiry' : 'enquiries') : 'No new enquiries';
    var select = $('app');
    select.textContent = '';
    data.apps.forEach(function (app) {
      var label = app.name + (app.pending ? ' (' + app.pending + ')' : '') + (app.unread ? ' · ' + app.unread + ' new' : '');
      select.appendChild(el('option', { value: app.id, text: label }));
    });
    if (data.apps.length === 0) {
      $('list').textContent = '';
      $('list').appendChild(el('p', { class: 'empty', text: 'No apps yet. Insert a row into the apps table first.' }));
      return false;
    }
    var remembered = localStorage.getItem('feedbackkit.app');
    state.app = data.apps.some(function (a) { return a.id === remembered; }) ? remembered : data.apps[0].id;
    select.value = state.app;
    return true;
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('header nav button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab);
    });
    $('filters-inbox').classList.toggle('hidden', tab !== 'inbox');
    $('filters-issues').classList.toggle('hidden', tab !== 'issues');
    $('detail').textContent = '';
    $('detail').appendChild(el('p', { class: 'empty', text: 'Select an item.' }));
    reload();
  }

  function showLoading() {
    $('list').textContent = '';
    $('list').appendChild(el('p', { class: 'empty', text: 'Loading…' }));
  }

  function reload() {
    showLoading();
    if (state.tab === 'inbox') { state.inbox.offset = 0; state.inbox.items = []; loadInbox(); }
    else { state.issues.offset = 0; state.issues.items = []; loadIssues(); }
  }

  // ---- Inbox ---------------------------------------------------------

  async function loadInbox() {
    var s = state.inbox;
    var seq = s.seq = (s.seq || 0) + 1;
    var params = new URLSearchParams({ app: state.app, state: s.state, kind: s.kind, q: s.q, offset: String(s.offset) });
    try {
      var data = await api('/admin/api/inbox?' + params.toString());
      if (seq !== s.seq) return; // a newer request superseded this one
      s.items = s.items.concat(data.submissions);
      s.hasMore = data.hasMore;
      renderInboxList();
    } catch (error) { toast(error.message, true); }
  }

  function renderInboxList() {
    var s = state.inbox;
    var list = $('list');
    list.textContent = '';
    if (s.items.length === 0) {
      list.appendChild(el('p', { class: 'empty', text: 'Nothing in ' + (s.state === 'all' ? 'the inbox' : STATES[s.state].toLowerCase()) + '.' }));
      return;
    }
    s.items.forEach(function (item) {
      var meta = [badge(KINDS[item.kind] || item.kind, 'k-' + item.kind), el('span', { text: formatDate(item.createdAt) })];
      if (item.issue) meta.push(el('span', { text: '#' + item.issue.number }));
      if (item.unread) meta.push(badge(item.unread + ' new', 'unread'));
      else if (item.messageCount) meta.push(el('span', { text: item.messageCount + ' msg' }));
      if (s.state === 'all') meta.push(el('span', { text: STATES[item.state] || item.state }));
      list.appendChild(el('button', {
        type: 'button',
        class: 'card' + (item.id === s.selectedId ? ' selected' : ''),
        onclick: function () { selectSubmission(item.id); }
      }, [el('span', { class: 't', text: item.title }), el('span', { class: 'm' }, meta)]));
    });
    if (s.hasMore) {
      list.appendChild(el('button', { type: 'button', class: 'more', text: 'Load more', onclick: function () { s.offset += 50; loadInbox(); } }));
    }
  }

  async function selectSubmission(id) {
    state.inbox.selectedId = id;
    renderInboxList();
    try {
      var data = await api('/admin/api/submissions/' + encodeURIComponent(id));
      renderSubmission(data.submission, data.messages || [], data.readThrough || {});
    } catch (error) { toast(error.message, true); }
  }

  function renderSubmission(sub, messages, readThrough) {
    var detail = $('detail');
    detail.textContent = '';
    detail.appendChild(el('h2', { text: sub.title }));
    detail.appendChild(el('div', { class: 'meta' }, [
      badge(KINDS[sub.kind] || sub.kind, 'k-' + sub.kind),
      el('span', { text: STATES[sub.state] || sub.state }),
      el('span', { text: formatDate(sub.createdAt) }),
      el('span', { text: 'Installation ' + sub.installationId.slice(0, 8), title: sub.installationId }),
      sub.attested ? badge('Verified device', 'k-idea') : null
    ]));
    detail.appendChild(el('pre', { class: 'raw', text: sub.body }));
    if (sub.attachments && sub.attachments.length) {
      detail.appendChild(el('div', { class: 'att-row' }, sub.attachments.map(attachmentImage)));
    }
    if (sub.diagnostics) {
      var diag = el('details', null, [el('summary', { class: 'count', text: 'Diagnostics attached by the app' })]);
      diag.appendChild(el('pre', { class: 'raw', text: JSON.stringify(sub.diagnostics, null, 2) }));
      diag.style.marginBottom = '20px';
      detail.appendChild(diag);
    }

    if (sub.state === 'published' && sub.issue) {
      detail.appendChild(el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'primary', text: 'Open issue #' + sub.issue.number, onclick: function () {
          setTabSilently('issues');
          selectIssue(sub.issue.id);
        } }),
        el('a', { href: '/board/' + encodeURIComponent(sub.appId) + '/' + sub.issue.number, target: '_blank', rel: 'noopener', text: 'View on board' })
      ]));
      detail.appendChild(conversationPanel(sub, messages, readThrough));
      return;
    }

    var title = el('input', { type: 'text', id: 'pub-title', value: sub.title, maxlength: '160' });
    var body = el('textarea', { id: 'pub-body', value: sub.body });
    var status = statusSelect('pub-status', 'reported', false);
    var release = el('input', { type: 'text', id: 'pub-release', placeholder: 'e.g. 2.1', maxlength: '40' });
    var publishButton = el('button', { type: 'submit', class: 'primary', text: 'Publish as new issue' });

    var form = el('form', { onsubmit: async function (event) {
      event.preventDefault();
      publishButton.disabled = true;
      try {
        var data = await api('/admin/api/submissions/' + encodeURIComponent(sub.id) + '/publish', {
          method: 'POST',
          body: { title: title.value, body: body.value, status: status.value, release: release.value || null }
        });
        toast('Published as #' + data.issue.number);
        await refreshInboxAfterChange(sub.id);
      } catch (error) { toast(error.message, true); }
      publishButton.disabled = false;
    } }, [
      el('fieldset', null, [
        el('legend', { text: 'Public copy (edit freely; the raw report above stays private)' }),
        el('label', { for: 'pub-title', text: 'Title' }), title,
        el('label', { for: 'pub-body', text: 'Description' }), body,
        el('div', { class: 'row' }, [
          el('div', null, [el('label', { for: 'pub-status', text: 'Status' }), status]),
          el('div', null, [el('label', { for: 'pub-release', text: 'Release (optional)' }), release])
        ]),
        el('div', { class: 'actions' }, [
          publishButton,
          sub.state === 'pending' ? el('button', { type: 'button', class: 'danger', text: 'Dismiss', onclick: function () { changeState(sub.id, 'dismiss'); } }) : null,
          sub.state === 'dismissed' ? el('button', { type: 'button', class: 'secondary', text: 'Restore to pending', onclick: function () { changeState(sub.id, 'restore'); } }) : null,
          el('button', { type: 'button', class: 'danger', text: 'Delete permanently', onclick: function () { deleteSubmission(sub); } })
        ])
      ])
    ]);
    detail.appendChild(form);
    detail.appendChild(conversationPanel(sub, messages, readThrough));
  }

  /** Private thread with the reporter, plus a reply box. Opening it marks everything read. */
  function conversationPanel(sub, messages, readThrough) {
    var box = el('fieldset', null, [el('legend', { text: 'Private conversation (' + messages.length + ')' })]);
    var thread = el('div', { class: 'thread' });
    if (messages.length === 0) {
      thread.appendChild(el('p', { class: 'count', text: 'No messages yet. Replies go only to the person who sent this report.' }));
    }
    messages.forEach(function (m) {
      var parts = [el('div', { class: 'who', text: (m.sender === 'developer' ? 'You' : 'Reporter') + ' · ' + formatDate(m.createdAt) })];
      if (m.body) parts.push(el('div', { class: 'txt', text: m.body }));
      (m.attachments || []).forEach(function (a) { parts.push(attachmentImage(a)); });
      thread.appendChild(el('div', { class: 'msg ' + m.sender }, parts));
    });
    box.appendChild(thread);

    // Images are uploaded as soon as they are picked, then sent by id with the reply.
    var pending = [];
    var thumbs = el('div', { class: 'thumbs' });
    var fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png', multiple: 'multiple' });
    fileInput.addEventListener('change', async function () {
      var files = Array.from(fileInput.files || []);
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (pending.length >= 4) { toast('At most 4 images per message.', true); break; }
        if (file.size > 5 * 1024 * 1024) { toast(file.name + ' is over 5 MB.', true); continue; }
        try {
          var res = await fetch('/admin/api/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
          var data = await res.json();
          if (!res.ok) throw new Error((data.error && data.error.message) || 'Upload failed');
          pending.push(data.attachment.id);
          thumbs.appendChild(el('img', { class: 'thumb', src: URL.createObjectURL(file), alt: file.name }));
        } catch (error) { toast(error.message, true); }
      }
      fileInput.value = '';
    });

    var input = el('textarea', { placeholder: 'Reply privately…', rows: '3', maxlength: '4000' });
    input.style.minHeight = '72px';
    var send = el('button', { type: 'button', class: 'primary', text: 'Send reply', onclick: async function () {
      var text = input.value.trim();
      if (!text && pending.length === 0) return;
      send.disabled = true;
      try {
        await api('/admin/api/submissions/' + encodeURIComponent(sub.id) + '/reply', { method: 'POST', body: { message: text, attachmentIds: pending } });
        toast('Reply sent');
        await selectSubmission(sub.id);
      } catch (error) { toast(error.message, true); send.disabled = false; }
    } });
    box.appendChild(input);
    box.appendChild(thumbs);
    box.appendChild(el('div', { class: 'actions' }, [send, fileInput]));

    var last = messages.length ? messages[messages.length - 1].seq : 0;
    if (last > (readThrough.developer || 0)) {
      api('/admin/api/submissions/' + encodeURIComponent(sub.id) + '/read', { method: 'POST', body: { through: last } })
        .then(function () { state.inbox.offset = 0; state.inbox.items = []; return loadInbox(); })
        .then(function () { return loadApps(); })
        .then(function () { $('app').value = state.app; })
        .catch(function () {});
    }
    return box;
  }

  /** Inline image for an attachment; click opens it full size in a new tab. */
  function attachmentImage(a) {
    var src = '/admin/api/attachments/' + encodeURIComponent(a.id);
    return el('img', { class: 'att', src: src, loading: 'lazy', alt: 'Attached image', onclick: function () { window.open(src, '_blank', 'noopener'); } });
  }

  function laneSelect(id, selected) {
    var select = el('select', { id: id });
    [['', 'Not on roadmap'], ['now', 'Now'], ['next', 'Next'], ['later', 'Later']].forEach(function (pair) {
      var option = el('option', { value: pair[0], text: pair[1] });
      if ((selected || '') === pair[0]) option.selected = true;
      select.appendChild(option);
    });
    return select;
  }

  async function changeState(id, action) {
    try {
      await api('/admin/api/submissions/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      toast(action === 'dismiss' ? 'Dismissed' : 'Restored');
      await refreshInboxAfterChange(id);
    } catch (error) { toast(error.message, true); }
  }

  /** Spam and abuse: removes the report, its conversation and images for good. A linked public issue stays. */
  async function deleteSubmission(sub) {
    var note = sub.state === 'published'
      ? '\\n\\nThe public issue it was published as stays on the board; only this report and its private conversation go.'
      : '';
    if (!confirm('Delete this report permanently?\\n\\n"' + sub.title + '"\\n\\nThe report, its private conversation and any images are removed and the reporter will no longer see it. This cannot be undone.' + note)) return;
    try {
      await api('/admin/api/submissions/' + encodeURIComponent(sub.id), { method: 'DELETE' });
      toast('Deleted');
      await refreshInboxAfterChange(sub.id);
    } catch (error) { toast(error.message, true); }
  }

  async function refreshInboxAfterChange(id) {
    state.inbox.offset = 0;
    state.inbox.items = [];
    await loadInbox();
    await loadApps();
    $('app').value = state.app;
    var stillListed = state.inbox.items.some(function (item) { return item.id === id; });
    if (stillListed) { selectSubmission(id); }
    else {
      $('detail').textContent = '';
      $('detail').appendChild(el('p', { class: 'empty', text: 'Done. Pick the next item.' }));
    }
  }

  // ---- Issues --------------------------------------------------------

  async function loadIssues() {
    var s = state.issues;
    var seq = s.seq = (s.seq || 0) + 1;
    var params = new URLSearchParams({ app: state.app, status: s.status, q: s.q, offset: String(s.offset) });
    try {
      var data = await api('/admin/api/issues?' + params.toString());
      if (seq !== s.seq) return; // a newer request superseded this one
      s.items = s.items.concat(data.issues);
      s.hasMore = data.hasMore;
      renderIssuesList();
    } catch (error) { toast(error.message, true); }
  }

  function renderIssuesList() {
    var s = state.issues;
    var list = $('list');
    list.textContent = '';
    if (s.items.length === 0) {
      list.appendChild(el('p', { class: 'empty', text: 'No issues yet. Publish something from the inbox.' }));
      return;
    }
    s.items.forEach(function (issue) {
      var meta = [badge(STATUSES[issue.status] || issue.status), el('span', { text: 'Updated ' + formatDate(issue.updatedAt) })];
      if (issue.release) meta.push(el('span', { text: issue.release }));
      list.appendChild(el('button', {
        type: 'button',
        class: 'card' + (issue.id === s.selectedId ? ' selected' : ''),
        onclick: function () { selectIssue(issue.id); }
      }, [el('span', { class: 't', text: '#' + issue.number + '  ' + issue.title }), el('span', { class: 'm' }, meta)]));
    });
    if (s.hasMore) {
      list.appendChild(el('button', { type: 'button', class: 'more', text: 'Load more', onclick: function () { s.offset += 50; loadIssues(); } }));
    }
  }

  async function selectIssue(id) {
    state.issues.selectedId = id;
    renderIssuesList();
    try {
      var data = await api('/admin/api/issues/' + encodeURIComponent(id));
      renderIssue(data.issue, data.submissions, data.mergedIntoNumber, data.mergedIssues || []);
    } catch (error) { toast(error.message, true); }
  }

  function renderIssue(issue, submissions, mergedIntoNumber, mergedIssues) {
    var detail = $('detail');
    detail.textContent = '';
    detail.appendChild(el('h2', null, ['#' + issue.number + ' ', el('span', { class: 'count', text: issue.title })]));
    detail.appendChild(el('div', { class: 'meta' }, [
      badge(STATUSES[issue.status] || issue.status),
      el('span', { text: '▲ ' + (issue.votes || 0) + ' · ' + (issue.follows || 0) + ' following' }),
      el('span', { text: 'Updated ' + formatDate(issue.updatedAt) }),
      el('a', { href: '/board/' + encodeURIComponent(state.app) + '/' + issue.number, target: '_blank', rel: 'noopener', text: 'View on board' }),
      el('a', { href: '/roadmap/' + encodeURIComponent(state.app), target: '_blank', rel: 'noopener', text: 'Roadmap' })
    ]));

    if (issue.mergedInto) {
      detail.appendChild(el('div', { class: 'notice' }, [
        'This issue was merged into ',
        el('button', { type: 'button', class: 'secondary', text: '#' + mergedIntoNumber, onclick: function () { selectIssue(issue.mergedInto); } }),
        '. Its number now redirects there; reports, votes and follows have moved across.'
      ]));
    }

    var title = el('input', { type: 'text', id: 'iss-title', value: issue.title, maxlength: '160' });
    var body = el('textarea', { id: 'iss-body', value: issue.body });
    var status = statusSelect('iss-status', issue.status, false);
    var release = el('input', { type: 'text', id: 'iss-release', value: issue.release || '', placeholder: 'e.g. 2.1', maxlength: '40' });
    var lane = laneSelect('iss-lane', issue.roadmapLane);
    var saveButton = el('button', { type: 'submit', class: 'primary', text: 'Save' });

    var form = el('form', { onsubmit: async function (event) {
      event.preventDefault();
      saveButton.disabled = true;
      try {
        var data = await api('/admin/api/issues/' + encodeURIComponent(issue.id), {
          method: 'PATCH',
          body: { title: title.value, body: body.value, status: status.value, release: release.value || null, roadmapLane: lane.value || null, version: issue.version }
        });
        toast('Saved');
        state.issues.offset = 0; state.issues.items = [];
        await loadIssues();
        renderIssue(data.issue, submissions, mergedIntoNumber, mergedIssues);
      } catch (error) {
        toast(error.message, true);
        if (error.status === 409 && error.data && error.data.issue) renderIssue(error.data.issue, submissions, mergedIntoNumber, mergedIssues);
      }
      saveButton.disabled = false;
    } }, [
      el('fieldset', null, [
        el('legend', { text: 'Public copy' }),
        el('label', { for: 'iss-title', text: 'Title' }), title,
        el('label', { for: 'iss-body', text: 'Description' }), body,
        el('div', { class: 'row' }, [
          el('div', null, [el('label', { for: 'iss-status', text: 'Status' }), status]),
          el('div', null, [el('label', { for: 'iss-release', text: 'Release (optional)' }), release]),
          el('div', null, [el('label', { for: 'iss-lane', text: 'Roadmap lane' }), lane])
        ]),
        el('div', { class: 'actions' }, [saveButton])
      ])
    ]);
    if (issue.mergedInto) form.querySelectorAll('input, textarea, select, button').forEach(function (n) { n.disabled = true; });
    detail.appendChild(form);

    if (!issue.mergedInto) {
      var mergeInput = el('input', { type: 'number', id: 'merge-into', min: '1', placeholder: 'Issue number' });
      var mergeButton = el('button', { type: 'button', class: 'danger', text: 'Merge into that issue', onclick: async function () {
        var n = parseInt(mergeInput.value, 10);
        if (!n) { toast('Enter the number of the issue to keep.', true); return; }
        if (!confirm('Merge #' + issue.number + ' into #' + n + '?\\n\\nReports, votes and follows move to #' + n + ', and #' + issue.number + ' will redirect there. This cannot be undone from here.')) return;
        mergeButton.disabled = true;
        try {
          await api('/admin/api/issues/' + encodeURIComponent(issue.id) + '/merge', { method: 'POST', body: { intoNumber: n } });
          toast('Merged into #' + n);
          state.issues.offset = 0; state.issues.items = [];
          await loadIssues();
          selectIssue(issue.id);
        } catch (error) { toast(error.message, true); mergeButton.disabled = false; }
      } });
      detail.appendChild(el('fieldset', null, [
        el('legend', { text: 'Merge duplicate' }),
        el('p', { class: 'count', text: 'If this is a duplicate of another issue, merge it into the one you want to keep.' }),
        el('div', { class: 'actions' }, [mergeInput, mergeButton])
      ]));
    }

    if (mergedIssues.length) {
      detail.appendChild(el('fieldset', null, [
        el('legend', { text: 'Merged into this issue (' + mergedIssues.length + ')' }),
        el('ul', { class: 'linked' }, mergedIssues.map(function (m) {
          return el('li', null, [el('button', { type: 'button', text: '#' + m.number + '  ' + m.title, onclick: function () { selectIssue(m.id); } })]);
        }))
      ]));
    }

    var linked = el('fieldset', null, [el('legend', { text: 'Reports behind this issue (' + submissions.length + ')' })]);
    if (submissions.length === 0) {
      linked.appendChild(el('p', { class: 'count', text: 'None linked.' }));
    } else {
      linked.appendChild(el('ul', { class: 'linked' }, submissions.map(function (sub) {
        return el('li', null, [
          el('button', { type: 'button', text: sub.title, onclick: function () {
            state.inbox.state = 'all'; $('inbox-state').value = 'all';
            setTabSilently('inbox').then(function () { selectSubmission(sub.id); });
          } }),
          el('div', { class: 'count', text: (KINDS[sub.kind] || sub.kind) + ' · ' + formatDate(sub.createdAt) })
        ]);
      })));
    }
    detail.appendChild(linked);
  }

  /** Switches tab chrome and reloads that tab's list without clearing the detail pane. Resolves when the list is loaded. */
  function setTabSilently(tab) {
    state.tab = tab;
    document.querySelectorAll('header nav button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab);
    });
    $('filters-inbox').classList.toggle('hidden', tab !== 'inbox');
    $('filters-issues').classList.toggle('hidden', tab !== 'issues');
    showLoading();
    if (tab === 'issues') { state.issues.offset = 0; state.issues.items = []; return loadIssues(); }
    state.inbox.offset = 0; state.inbox.items = []; return loadInbox();
  }

  // ---- Wiring --------------------------------------------------------

  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  document.querySelectorAll('header nav button').forEach(function (button) {
    button.addEventListener('click', function () { setTab(button.getAttribute('data-tab')); });
  });
  $('app').addEventListener('change', function () {
    state.app = $('app').value;
    localStorage.setItem('feedbackkit.app', state.app);
    setTab(state.tab);
  });
  $('inbox-state').addEventListener('change', function () { state.inbox.state = $('inbox-state').value; reload(); });
  $('inbox-kind').addEventListener('change', function () { state.inbox.kind = $('inbox-kind').value; reload(); });
  $('inbox-q').addEventListener('input', debounce(function () { state.inbox.q = $('inbox-q').value.trim(); reload(); }, 250));
  var issuesStatus = $('issues-status');
  Object.keys(STATUSES).forEach(function (key) { issuesStatus.appendChild(el('option', { value: key, text: STATUSES[key] })); });
  issuesStatus.addEventListener('change', function () { state.issues.status = issuesStatus.value; reload(); });
  $('issues-q').addEventListener('input', debounce(function () { state.issues.q = $('issues-q').value.trim(); reload(); }, 250));

  (async function start() {
    try {
      var me = await api('/admin/api/me');
      $('me').textContent = me.email;
      if (await loadApps()) reload();
    } catch (error) { toast(error.message, true); }
  })();
})();
</script>
</body>
</html>`;
