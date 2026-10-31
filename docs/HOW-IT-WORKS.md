# Nuke feedback system: the complete rundown

*Last updated 22 October 2026. This describes what is deployed at
`https://feedback.nukeyapp.com`. The README covers setup commands; this
document explains how the pieces fit and behave.*

---

## 1. What it is

A self-hosted, in-app feedback system for all Show Creative apps, branded
"Powered by Nuke". One Cloudflare Worker and one database serve every app.
Users send bugs and ideas from inside an app without creating an account,
follow what happens to them, vote on other people's items, and talk to the
developer privately. The developer reviews everything in a web admin, decides
what becomes public, and keeps a board and a roadmap that anyone can read.

Three parts:

| Part | Where | What it does |
|---|---|---|
| Worker (`worker/`) | Cloudflare Workers + D1 (SQLite) + R2 (images) | API, public board and roadmap pages, admin page, App Attest verification |
| Swift package `FeedbackKit` (`Sources/`) | Linked into each app | Client, form, My Reports, conversation, in-app board |
| Host websites | e.g. `nukeyapp.com/feedback.html` | Optionally frame the public board inside the app's own site |

Registered apps today: NuKey (`nukey`), WallBoard (`wallboard`), mLite (`mlite`).

---

## 2. The two-sided model: reports and issues

Everything hinges on one separation.

**A report (submission)** is what a user sends. It is private. It belongs to
one installation of one app and has a kind (Issue, Idea, Other), a title, a
body, optional screenshots, optional diagnostics, and a private conversation
thread with the developer. Users only ever see their own reports.

**An issue** is what the developer publishes. It is public, has a number
(`#1`, `#2`, …, per app), its own cleaned-up title and body, a status, an
optional release tag, an optional roadmap lane, and vote and follow counts.
Many reports can link to one issue (duplicates), and an issue can exist
without the user's wording ever appearing in public.

Why: users write messy, personal, sometimes sensitive text and attach
screenshots of their own phone. The public only ever sees the developer's
reviewed copy. Names, screenshots and private conversations never leave the
admin.

### Report states

| State | Shown to the reporter as | Meaning |
|---|---|---|
| `pending` | Received | In the inbox, not yet reviewed |
| `published` | Published | Linked to a public issue; the report then shows that issue's number and status |
| `dismissed` | Closed | Reviewed and not taken forward; can be restored to pending |

### Issue statuses

| Status | Board column | Typical use |
|---|---|---|
| `reported` | Reported | Acknowledged, no decision yet |
| `planned` | Planned | Will be done |
| `in_progress` | In progress | Being built |
| `pending` | Pending | Blocked or waiting (on Apple, on a decision, on a beta) |
| `testing` | Testing | In a beta build |
| `complete` | Complete | Shipped; set the release tag so the board groups it under that version |
| `closed` | Closed | Won't be done or no longer applies |

Status changes are visible to reporters immediately under My Reports. There
are no push notifications by design; reporters see updates when they open the
app.

---

## 3. The user's journey inside an app

1. **Open Help & Feedback.** The host app presents a hub sheet with Send
   Feedback, Feedback Board and My Reports. All three carry the
   "Powered by Nuke" badge.
2. **Send Feedback.** The form asks for kind, title (5 to 160 characters) and
   details (10 to 10,000 characters). Up to four screenshots can be attached
   from the photo library (the same limit applies per conversation message); each is downscaled on device to at most 2048 px and
   re-encoded as JPEG before upload. A diagnostics toggle, on by default, adds
   app version, build, OS, device model, locale and time zone; the exact
   contents are shown in the footer so nothing is hidden. The consent footer
   explains that an anonymous installation identifier is shared and asks the
   user not to include passwords.
3. **Behind the scenes on first send.** The app registers the installation
   once. On a real device with the App Attest capability it attests a Secure
   Enclave key first (see section 7); otherwise it registers plainly. A bearer
   token is stored in the Keychain, this device only, not synced. The form
   mints a request id when it opens and keeps the draft on disk until the
   server confirms, so a retry after a network failure never creates a
   duplicate.
4. **My Reports.** Lists the user's own reports with state, linked issue
   number and status, and unread reply count. Tapping one opens the
   conversation.
5. **Conversation.** A Messages-style thread between the reporter and the
   developer: grouped bubbles with tails, time separators, a capsule composer
   with a plus button for images, inline image bubbles that open full-screen
   with pinch to zoom. Reporters can keep adding information or reply to
   developer questions here. Replies are 1 to 4,000 characters.
6. **Feedback Board.** The public issues for this app, searchable, filterable
   by status, sortable by newest or most voted. Tapping an issue shows its
   detail with Vote and Follow toggles. Votes and follows are per installation
   and toggle on and off; the view updates optimistically.

What users cannot do: see other people's reports, see who voted, comment
publicly, or edit a report after sending (they add to the conversation instead).

---

## 4. The developer's workflow in the admin

`https://feedback.nukeyapp.com/admin`, protected by Cloudflare Access
(section 7). The page is one self-contained HTML/JS app served by the Worker.

**Inbox.** Choose an app (the picker shows pending and unread counts), filter
by state and kind, search. Each report shows kind, title, body, diagnostics,
attachments, whether the device was verified by App Attest, and the private
conversation.

For each report you can:

- **Reply.** Opens or continues the private thread. You can attach images
  too. The reporter sees it under My Reports; unread counts are tracked per
  conversation and per side.
- **Publish as new issue.** Write the public title and body (defaults to the
  report's text, edit freely), pick a status, optionally a release and a
  roadmap lane. This creates the issue and links the report to it.
- **Duplicates.** There is no "attach to existing issue" button. Publish the
  duplicate report as its own issue, then use **Merge duplicate** on that
  issue (section below). The report follows the merge, so the reporter sees
  the surviving issue's number and status.
- **Dismiss.** The reporter sees "Closed". Nothing public is created.
  **Restore to pending** undoes it.
- **Delete permanently.** For spam and abuse. Removes the report, its
  private conversation, read markers and every image (including the bytes in
  storage) after a confirmation. The reporter's My Reports simply no longer
  lists it. If the report had been published, the public issue stays, because
  that is your own copy; close or edit the issue separately if needed. There
  is no undo.

**Issues.** The published list, filterable by status, searchable. Editing an
issue changes title, body, status, release and roadmap lane. Edits carry a
version number, so two tabs editing the same issue cannot silently overwrite
each other: the second save is refused until it reloads.

**Merge duplicate.** Merges this issue into another in the same app. Reports,
votes and follows move across (each installation counts once), and the merged
issue becomes a pointer: its old public URL redirects permanently to the
survivor. The survivor's detail lists what was merged into it.

**Release grouping.** When an issue is Complete and has a release tag, the
public Complete column groups it under that version with a count, collapsed by
default. Use a consistent format (`1.1.10`) so grouping works.

---

## 5. The public web pages

All served by the Worker, no JavaScript needed to read them, light and dark
aware.

| URL | Content |
|---|---|
| `/board` | Every app, with an App filter |
| `/board/<app>` | One app's board |
| `/board/<app>/<number>` | One issue (merged issues redirect to the survivor) |
| `/roadmap` and `/roadmap/<app>` | Now / Next / Later lanes plus Shipped |
| `/timeline` and `/timeline/<app>` | Each issue's status journey over time |
| `/embed/progress/<app>` | The "Feedback and progress" card for embedding on a website |
| `/` | The Nuke landing page: what the suite does, how it is built, and a contact form for developers who would like to use it. Enquiries are stored and listed at `/admin/enquiries` with a handled toggle; the badge on every page links here |

**Board view.** Seven status columns in order, each capped at 100 cards with a
"show all" link into list view. Cards show number, kind, title, app (on the
cross-app board), date, vote count. The toolbar offers Board/List toggle,
status filter (which forces list view), title search and most-voted sort.

**Stats tile.** Top right: reports over the last 31 days as a grid, one column
per day, one cell per report, coloured by the status the report's issue has
reached (grey for not yet published). Days with more than five reports collapse
the extras into the top cell with a tooltip. Underneath: counts of Reported,
In progress and Completed issues.

**Roadmap.** Three lanes you set, Now ("Being worked on"), Next ("Coming up
after that"), Later ("On the list, not yet scheduled"), plus a fourth column
you never touch: **Shipped**. An issue appears on the roadmap only when you
give it a lane in the admin. While it is open it sits in that lane, most voted
first. The moment its status becomes Complete it leaves the lane and shows
under Shipped, grouped by release like the board's Complete column, so the
roadmap doubles as a record of promises kept. If you close it instead, it
drops off the roadmap. The stored lane is never changed automatically, so
there is nothing to tidy up. The roadmap exists only on the web; the in-app
BoardView has no lane filter.

**Timeline.** Each issue drawn as a bar from first report to now, or to the
moment it was completed or closed, split into coloured segments for every
status it passed through, with a tooltip giving how long each stage took and
a label such as "Open for 3d" or "Completed in 23h". Rows are ordered by
most recent activity, 25 per page, with the same app, status and search
filters as the board. The span control ("One screen shows") fits the chart to
the issues on the page or pins the window to the last 30 days, 7 days, day,
6 hours or hour. Status history is recorded from the moment an issue is
published and on every status edit; issues that existed before the timeline
was added show an approximated path (Reported from creation until their last
edit, then their current status).

**Progress card.** `/embed/progress/<app>` is a standalone card meant to be
framed on the app's own website: headline Reported / In progress / Completed
totals, a grid with one row per status and one column per day for the last 31
days (the Reported row counts reports received, the others count issues
entering that status that day, darker meaning more), a "N reports over 31
days" line, a legend, and an "Explore feedback" link to the board. It uses
the same embed handshake as the board. nukeyapp.com shows it on the home page.

**Footer.** The "Powered by Nuke" badge (speech bubble with three rising bars)
and the line "Only reviewed, published items appear here."

### Embedding in your own site

Any page can frame a board or roadmap URL. When the page detects it is framed
it hides its own header (the host already has one), makes its background
transparent, listens for `{type: "fk:theme", theme: "light" | "dark"}` to pin
a colour scheme (remembered for navigation inside the frame), and posts
`{type: "fk:height", height}` after every layout change so the host can size
the frame and keep a single scrollbar. `nukeyapp.com/feedback.html` does this
in about fifteen lines of script; copy it for other sites.

---

## 6. Data model (D1)

| Table | Holds |
|---|---|
| `apps` | id, name, bundle id. One row per app; inserting a row is how an app is onboarded |
| `installations` | One row per app install: hashed token, app, created/last seen, `attested` flag |
| `submissions` | Reports: kind, title, body, state, request id (unique, for idempotency), diagnostics JSON, payload hash |
| `issues` | Public items: per-app number, title, body, status, release, roadmap lane, merged_into, version |
| `submission_issue_links` | Which reports back which issue |
| `votes`, `follows` | (issue, installation) pairs |
| `messages` | Conversation messages, with side (reporter or developer) |
| `conversation_reads` | Read marker per conversation per side |
| `attachments` | Image metadata; bytes live in the R2 bucket `feedbackkit-attachments` |
| `attest_challenges`, `attest_keys` | App Attest one-time challenges and verified keys with counters |
| `issue_status_history` | Every status an issue has entered and when, for the timeline and progress card |

Images: JPEG or PNG only, checked by magic number, 5 MiB cap per image.
Uploads that are never linked to a report or message are swept by a nightly
cron (03:17 UTC). Images are served only to the uploading installation, the
reporter of the parent report, or the admin.

Lengths are counted in Unicode scalars on both client and server so the two
never disagree.

---

## 7. Security and abuse resistance

**No accounts.** Identity is an installation token issued at registration and
stored in the Keychain. Losing the token (reinstall) means losing access to
earlier reports; there is deliberately no recovery flow and no email.

**App Attest.** Mode is `optional` in production. On a real device the client
generates a Secure Enclave key, fetches a one-time challenge, attests the key
through Apple, and registers with the attestation. The Worker verifies the
certificate chain against Apple's root, the nonce, the team and bundle id, and
stores the key. From then on every write (submit, reply, vote, follow) carries
three headers: key id, client data (`{bodyHash, challenge, method, path}`) and
an assertion signed by the key, and the Worker checks the signature and that
the counter increased. The admin shows "Verified device" for attested
installations. Simulators, older devices or apps without the capability fall
back to a plain token; switching the Worker to `required` would reject them.
If the server ever demands attestation from a plain installation, the client
upgrades it in place and retries once.

**Idempotency.** Submits and replies carry a client request id. The same
request again returns the same result; a different body under a reused id is
refused, and the form offers "Send as a New Report".

**Rate limits** (Cloudflare rate-limiting bindings, per minute):

| Action | Limit |
|---|---|
| Register, per IP | 5 |
| Submit, per installation / per IP | 5 / 20 |
| Reply, per installation | 10 |
| Vote or follow, per installation | 30 |
| Attest, per IP | 30 |
| Upload, per installation | 20 |

Clients receive `Retry-After` and the form shows it.

**Body caps.** 1 MiB for JSON, 6 MiB on the two upload routes.

**Admin access.** `/admin` sits behind Cloudflare Access. The Worker verifies
the Access JWT on every admin request (RS256 against the team's public keys,
audience check), so the admin API cannot be reached even if the Access rule
were misconfigured at the edge. Allowed identities are managed in the
Cloudflare One dashboard, not in code. Locally, with the Access variables
blank in `.dev.vars`, the admin is open on localhost only.

**Privacy posture.** No analytics, no third-party services, no email
addresses. Diagnostics are opt-out per report and shown in full before
sending. Public pages never render anything a user typed.

---

## 8. The Swift package at a glance

- `FeedbackConfiguration(baseURL:appID:attestation:)` and one shared
  `FeedbackClient` (an actor) per app.
- Views: `FeedbackForm`, `MyReportsView`, `ConversationView`, `BoardView`,
  plus `FeedbackBrandBadge` and `FeedbackBrandMark`.
- Client methods for everything the views do, usable directly: `submit`,
  `myReports`, `conversation`, `reply`, `markConversationRead`,
  `unreadReplies`, `uploadAttachment`, `attachmentData`, `board`, `vote`,
  `follow`, `isAttested`, `isRegistered`, `resetInstallation`.
- iOS 17 and macOS 14 or later, Swift 6 strict concurrency, no third-party
  dependencies. Views use system fonts and colours and inherit the host's tint.
- Tests run against a mock URL protocol: 40 tests, `swift test` on the Mac.

`unreadReplies` exists for a badge feature that was built and then removed
from NuKey; it stays available if a host wants it.

---

## 9. Operations

- **Deploy the Worker:** `cd worker && npm run deploy`. Variables such as the
  Access team domain, audience, Apple team id and attest mode live in
  `wrangler.toml` `[vars]` and are redeployed with the code.
- **Migrations:** `npm run db:migrate:remote` after adding a file under
  `worker/migrations/`. Four exist so far.
- **Onboard an app:** insert an `apps` row (README, "Adding another app"),
  link the package, add App Attest, add the hub sheet. No redeploy.
- **Rename the brand:** `BRAND` in `worker/src/html.ts` and
  `FeedbackBrand.name` in `Sources/FeedbackKit/Views/FeedbackBrand.swift`.
- **Local development:** `npm run dev` with `.dev.vars` blanking the Access
  variables; the admin is then open on localhost. The local D1 is separate
  and can be seeded freely.
- **Costs:** everything sits inside Cloudflare's free tiers at current volume
  (Workers requests, D1 reads, R2 storage, rate-limit bindings).

---

## 10. Deliberate non-features

- No push notifications or email; updates are seen on next open.
- No public comments; discussion is private between reporter and developer.
- No account recovery; the installation is the identity.
- No arbitrary file attachments; images only.
- No in-app roadmap; it is a web view, embeddable in each app's site.
- Nothing from AppBuddy or any other product: the design is original and the
  code is this repository's.
