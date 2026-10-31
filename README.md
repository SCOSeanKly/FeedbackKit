# FeedbackKit

Self-hosted in-app feedback for iOS apps, branded **Powered by Nuke**.

Users send bugs and ideas from inside your app without an account, follow what
happens to them, vote on other people's items and talk to you privately. You
review everything in a web admin, decide what becomes public, and keep a board
and a roadmap anyone can read or embed. One Cloudflare Worker and one database
serve all of your apps.

- **Private by default.** Reports, screenshots and conversations are only ever
  visible to the reporter and the admin. The public sees issues you write.
- **No accounts, no email.** An installation is the identity; the token lives
  in the Keychain. App Attest proves writes come from your genuine app.
- **Drop-in SwiftUI.** A form, My Reports with Messages-style conversations,
  and a board with votes and follows. System fonts and colours, inherits your tint.
- **Server-rendered board and roadmap.** Status columns, releases grouped under
  Complete, a 31-day activity grid, Now / Next / Later lanes. Embeddable in your
  own site with a theme and height handshake.
- **Runs on Cloudflare's free tier.** Workers, D1, R2, rate-limit bindings and
  Access. No third-party services, no analytics.

For how the system behaves end to end (reports vs issues, the admin workflow,
security, operations) read [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

---

## Contents

1. [Repository layout](#repository-layout)
2. [Quick start](#quick-start)
3. [Adding an app](#adding-an-app)
4. [Swift package](#swift-package)
5. [Worker configuration](#worker-configuration)
6. [HTTP API](#http-api)
7. [Admin](#admin)
8. [Public pages and embedding](#public-pages-and-embedding)
9. [Branding](#branding)
10. [Development](#development)

---

## Repository layout

```
FeedbackKit/
├── Package.swift                         Swift package: iOS 17+ / macOS 14+, no dependencies
├── Sources/FeedbackKit/
│   ├── FeedbackConfiguration.swift       baseURL, appID, attestation policy
│   ├── FeedbackClient.swift              actor: register once, Keychain token, signed writes, retries
│   ├── FeedbackModels.swift              kinds, limits, draft + validation, wire types
│   ├── FeedbackError.swift               typed errors mapped from HTTP statuses
│   ├── FeedbackAttestation.swift         App Attest provider seam (DeviceCheck by default)
│   ├── FeedbackDiagnostics.swift         optional app/OS/device summary attached to reports
│   ├── FeedbackImages.swift              on-device downscale to JPEG, attachment cache
│   ├── FeedbackTokenStore.swift          Keychain-backed token store (protocol for tests)
│   ├── FeedbackDraftStore.swift          persists the in-progress draft and its requestId
│   ├── Views/FeedbackForm.swift          "Send Feedback" sheet
│   ├── Views/MyReportsView.swift         the user's reports → ConversationView
│   ├── Views/ConversationView.swift      Messages-style thread with inline images
│   ├── Views/BoardView.swift             public issues, vote / follow, search, filters
│   ├── Views/Attachments.swift           picker strip, thumbnails, full-screen viewer
│   ├── Views/FeedbackBrand.swift         "Powered by" badge and mark
│   └── Resources/Localizable.xcstrings
├── Tests/FeedbackKitTests/               40 tests against a URLProtocol mock (swift test)
├── FeedbackKit/FeedbackKitExample.xcodeproj  example iOS app (target FeedbackKitExample)
├── docs/HOW-IT-WORKS.md                  plain-language system guide
└── worker/
    ├── wrangler.toml                     D1, R2, rate limits, cron, [vars]
    ├── migrations/0001…0005.sql          schema: core, conversations, attest + diagnostics, attachments, status history
    └── src/
        ├── index.ts                      Hono app, body caps, error handler, nightly sweep
        ├── auth.ts · access.ts           installation bearer + assertions · Cloudflare Access JWT
        ├── appattest.ts · attest-store.ts App Attest verification (CBOR/DER, Apple root) · keys, challenges
        ├── html.ts · admin-ui.ts         public pages · the /admin single-page app
        ├── issues.ts · validation.ts · ratelimit.ts · crypto.ts · errors.ts · env.ts
        └── routes/  register · attest · submit · mine · attachments · engage · conversation · board · admin
```

---

## Quick start

### 1. Deploy the Worker

Requires a Cloudflare account and Node 20+.

```sh
cd worker
npm install
npm run db:create                 # prints a database_id; paste it into wrangler.toml
npx wrangler r2 bucket create feedbackkit-attachments
npm run db:migrate:remote
npm run deploy
```

Give the Worker a hostname you control (Workers › Settings › Domains & Routes),
for example `feedback.example.com`. The Swift client only ever talks to that
host.

### 2. Protect the admin with Cloudflare Access

1. Zero Trust › Access controls › Applications › Add › **Self-hosted**.
   Domain: your Worker host, path `admin`. Policy: allow your email.
2. Copy the application's **Audience (AUD) tag** and your team domain
   (`<team>.cloudflareaccess.com`) into `[vars]` in `wrangler.toml`
   (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) and `npm run deploy` again.

The Worker verifies the `Cf-Access-Jwt-Assertion` token (RS256 against the
team's published keys, plus `aud`, `iss`, `exp`) on every admin request, so
`/admin/api/*` is closed even if the edge rule is wrong. With `ACCESS_AUD`
empty, the admin is open on localhost only.

### 3. Register your first app and add the package

See [Adding an app](#adding-an-app). Then open `https://<host>/admin`.

---

## Adding an app

Each app is one row in `apps` and one `appID` in the client. Nothing else is
per app, and no redeploy is needed.

1. **Register it.** The id becomes the public URL (`/board/<id>`,
   `/roadmap/<id>`); the name is what the board shows; the bundle id is
   checked by App Attest.

   ```sh
   cd worker
   npx wrangler d1 execute feedbackkit --remote --command \
     "INSERT INTO apps (id, name, bundle_id) VALUES ('myapp', 'My App', 'com.example.myapp')"
   ```

2. **Link the package.** Xcode › File › Add Package Dependencies › Add Local…
   and choose this repository's root (or a git URL and tag). Add the
   `FeedbackKit` library to the app target.

3. **Add the App Attest capability** under Signing & Capabilities. Optional
   while the Worker runs `ATTEST_MODE=optional`; it earns the "Verified
   device" badge in the admin and lets you switch to `required` later.

4. **Create one client and a hub sheet:**

   ```swift
   import FeedbackKit

   enum AppFeedback {
       static let client = FeedbackClient(configuration: FeedbackConfiguration(
           baseURL: URL(string: "https://feedback.example.com")!,
           appID: "myapp"
       ))
   }

   struct FeedbackHubSheet: View {
       @Environment(\.dismiss) private var dismiss
       @State private var showsForm = false
       var body: some View {
           NavigationStack {
               List {
                   Button { showsForm = true } label: { Label("Send Feedback", systemImage: "square.and.pencil") }
                   NavigationLink { BoardView(client: AppFeedback.client) } label: { Label("Feedback Board", systemImage: "rectangle.3.group") }
                   NavigationLink { MyReportsView(client: AppFeedback.client) } label: { Label("My Reports", systemImage: "tray.full") }
               }
               .navigationTitle("Help & Feedback")
               .toolbar { Button("Done") { dismiss() } }
               .sheet(isPresented: $showsForm) { FeedbackForm(client: AppFeedback.client) }
           }
       }
   }
   ```

   Present `FeedbackHubSheet()` from wherever the app keeps Help or Settings.

---

## Swift package

```swift
let feedback = FeedbackClient(configuration: FeedbackConfiguration(
    baseURL: URL(string: "https://feedback.example.com")!,
    appID: "myapp",
    attestation: .whenAvailable          // default; .disabled to skip App Attest
))

FeedbackForm(client: feedback)                      // sheet
FeedbackForm(client: feedback, diagnostics: nil)    // hide the diagnostics toggle
FeedbackForm(client: feedback) { receipt in … }     // onSubmitted callback
BoardView(client: feedback)                         // inside your NavigationStack
MyReportsView(client: feedback)                     // pushes ConversationView per report
FeedbackBrandBadge()                                // "Powered by" badge, if you want it elsewhere

// Direct client use:
let page   = try await feedback.board(sort: .top)
try await feedback.vote(issueNumber: 12, on: true)
let thread = try await feedback.conversation(submissionID: report.id)
try await feedback.reply(submissionID: report.id, requestID: UUID(), message: "Still happening in 1.3.")
let unread = try await feedback.unreadReplies()
```

Behaviour worth knowing:

- **Registration is lazy and single-flight.** The token is stored in the
  Keychain (`AfterFirstUnlockThisDeviceOnly`, not synced). A 401 re-registers once.
- **App Attest** runs on first registration on a real device with the
  capability: a Secure Enclave key is attested and every write (submit, reply,
  vote, follow) is signed. Simulators and apps without the capability fall back
  to a plain token. A 403 `attestation_*` from the server triggers an in-place
  upgrade and one retry.
- **Idempotent sends.** The form mints a `requestId` when it opens and keeps
  the draft in Application Support until the server confirms. `.conflict`
  (same id, different content) lets the form offer "Send as a New Report".
- **Images.** Up to four per report or message, downscaled on device to at
  most 2048 px and re-encoded as JPEG, uploaded before the send, viewed inline
  and full-screen with pinch to zoom. Fetched bytes are cached in memory.
- **Diagnostics.** `FeedbackDiagnostics.current()` (app version, build, OS,
  device model, locale, time zone) is offered with an on-by-default toggle and
  its exact contents shown in the footer. Add your own with
  `.current(extras: ["screen": "Settings"])`.
- **Limits** are counted in Unicode scalars on both sides: title 5–160, body
  10–10,000, message 1–4,000.
- `FeedbackError` is `Equatable`; `.rateLimited(retryAfter:)` carries the
  parsed `Retry-After`.

---

## Worker configuration

All in `worker/wrangler.toml`. Values in `[vars]` are deployed with the code
and override anything set in the dashboard.

| Variable | Purpose |
|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Cloudflare Access verification for `/admin`. Empty = localhost-only admin |
| `APPLE_TEAM_ID` | With each app's `bundle_id`, the App ID attestations must carry |
| `ATTEST_MODE` | `off` never verify · `optional` (default) attested installations must sign, others still work · `required` unattested writes get 403 and plain register is refused |
| `ATTEST_ALLOW_DEVELOPMENT` | `true` accepts Xcode development builds; `false` for App Store only |

Bindings: D1 `DB` (`feedbackkit`), R2 `ATTACHMENTS` (`feedbackkit-attachments`),
and rate limits (per minute): register 5/IP · submit 5/installation and 20/IP ·
reply 10 · vote/follow 30 · attest 30/IP · upload 20. Cron `17 3 * * *` deletes
uploads never linked to a report or message.

Body caps: 1 MiB for JSON, 6 MiB on the two upload routes (5 MiB per image,
JPEG or PNG by magic number).

Local development: `worker/.dev.vars` (gitignored) with the two `ACCESS_*`
values blank opens the admin on localhost.

---

## HTTP API

All bodies are JSON unless noted. Errors are `{error: {code, message}}`:
401 bad or missing token · 403 attestation (`attestation_required`,
`assertion_required`, `assertion_invalid`) · 404 unknown app or item ·
409 request-id conflict · 413 body too large · 429 with `Retry-After`.

### Installation

| Endpoint | Auth | Body | Response |
|---|---|---|---|
| `POST /api/register` | none | `{app}` | `201 {token}` |
| `POST /api/attest/challenge` | none | `{purpose: "register" \| "assert", path}` | `{challenge, expiresIn}`; single use, 5 minutes |
| `POST /api/attest/register` | optional bearer | `{app, keyId, challenge, attestation}` | `201 {token, upgraded: false}` new attested installation · `200 {token: null, upgraded: true}` when the bearer's installation was upgraded in place |

Attested installations sign `POST /api/submit`, `/reply`, `/vote` and `/follow`
with `X-Attest-Key`, `X-Attest-Client-Data` (base64 JSON `{bodyHash,
challenge, method, path}`, sorted keys) and `X-Attest-Assertion` (base64
CBOR). The server checks the challenge was issued for that path, the body hash,
the signature against the stored key, and that the counter strictly increased.

### Reports and conversations

| Endpoint | Body | Response |
|---|---|---|
| `POST /api/submit` | `{requestId, kind, title, body, diagnostics?, attachmentIds?}` | `201 {id, state}` · `200` identical retry · `409` same id, different content |
| `POST /api/mine` | `{offset}` | `{submissions, hasMore}` (50/page); each row carries `issue {number, status}`, `messageCount`, `unreadCount`, `lastMessageAt` |
| `POST /api/conversation` | `{submissionId, after}` | `{messages, hasMore, nextAfter}`, own reports only |
| `POST /api/reply` | `{submissionId, requestId, message, attachmentIds?}` | `201 {message}` · `200` identical retry · `409` conflict |
| `POST /api/conversation-read` | `{submissionId, through}` | `{readThrough}` |
| `POST /api/unread` | `{}` | `{unread}` developer replies not yet read |
| `POST /api/attachments` | raw `image/jpeg` or `image/png`, `X-Image-Width`, `X-Image-Height` | `201 {attachment: {id, contentType, bytes, width, height}}`; unlinked until used |
| `GET /api/attachments/:id` | | the bytes, if this installation uploaded it or it belongs to one of its reports |

`kind` is `issue`, `idea` or `other`. `diagnostics` is a shallow JSON object up
to 16 KiB, stored privately. A reply may have empty text when images are attached.

### Board

| Endpoint | Body | Response |
|---|---|---|
| `POST /api/vote` · `POST /api/follow` | `{issueNumber, on}` | `{issueNumber, votes, voted, follows, following}`; merged numbers resolve to the retained issue |
| `GET /api/board/:appId?status=&q=&sort=&offset=` | optional bearer | `{app, issues, hasMore}`, 25 per page; `sort=top` orders by votes. With a bearer the response adds this installation's `voted` / `following` and is `private, no-store` |

---

## Admin

`/admin` is a self-contained HTML/JS app; `/admin/api/*` is its JSON API. Both
require a valid Access JWT (localhost excepted in development).

| Endpoint | Purpose |
|---|---|
| `GET /admin/api/me` | signed-in email |
| `GET /admin/api/apps` | apps with pending and unread counts, plus `unhandledEnquiries` for the header badge |
| `GET /admin/api/inbox?app&state&kind&q&offset` | reports; `state` = `pending` (default), `published`, `dismissed`, `all` |
| `GET /admin/api/submissions/:id` | one report with diagnostics, attachments, linked issue and the private conversation |
| `POST /admin/api/submissions/:id/publish` | `{title, body, status?, release?, roadmapLane?}` → creates the public issue (next per-app number) and links the report |
| `POST /admin/api/submissions/:id/dismiss` · `/restore` | dismissed ⇄ pending |
| `DELETE /admin/api/submissions/:id` | hard delete for spam: the report, its conversation, read markers, issue links and attachments (R2 bytes too). A linked public issue stays |
| `POST /admin/api/submissions/:id/reply` · `/read` | `{message, attachmentIds?}` · `{through}` |
| `POST /admin/api/attachments` · `GET /admin/api/attachments/:id` | upload an image for a reply · view any attachment |
| `GET /admin/api/issues?app&status&q&offset` | issues, newest-updated first |
| `GET /admin/api/issues/:id` | issue plus the reports behind it, issues merged into it, `mergedIntoNumber` |
| `PATCH /admin/api/issues/:id` | `{title, body, status, release, roadmapLane?, version}`; stale `version` → 409 with the current row |
| `POST /admin/api/issues/:id/merge` | `{intoNumber}`: reports, votes and follows move to the retained issue; this number redirects |

Issue statuses: `reported`, `planned`, `in_progress`, `pending`, `testing`,
`complete`, `closed`. Roadmap lanes: `now`, `next`, `later` or null. Every
status an issue enters is appended to `issue_status_history` (on publish and
on status edits); the public timeline and the progress card read from it. Issue
titles are 3–160 scalars, bodies up to 10,000 (may be empty), release up to 40.

---

## Public pages and embedding

| URL | Content |
|---|---|
| `GET /board?app=&view=&status=&q=&offset=` | every app, status columns (default) or `view=list`, App filter |
| `GET /board/:appId?…` | one app, same views |
| `GET /board/:appId/:number` | one issue; merged numbers 301 to the retained issue |
| `GET /roadmap` · `GET /roadmap/:appId` | Now / Next / Later (most voted first) plus a derived Shipped column: roadmap items that reached Complete, grouped by release |
| `GET /timeline?app=&status=&q=&span=&offset=` · `GET /timeline/:appId?…` | each issue as a bar from first report to now (or completion), split by the statuses it passed through; `span` = `fit` (default), `30d`, `7d`, `1d`, `6h`, `1h`; 25 per page |
| `GET /` · `POST /contact` | the Nuke landing page (what it is, how it works) and its contact form; enquiries are stored in `enquiries` and listed at `/admin/enquiries` (Access-protected), 3 per minute per IP, honeypot field |
| `GET /embed/progress/:appId` | self-contained "Feedback and progress" card for an app's own website: Reported / In progress / Completed totals, a status-by-day grid for the last 31 days, link to the board |

The columns view shows one column per status with exact counts and up to 100
newest items each; Complete groups items by release in collapsible sections.
Choosing a status switches to the list. The header tile shows the last 31 days
as a grid, one column per day and one cell per report coloured by the status
its issue has reached, with Reported / In progress / Completed totals beneath.
Only `issues` rows are ever rendered; every string is HTML-escaped; responses
carry `Cache-Control: public, max-age=60`.

**Embedding.** Frame any board or roadmap URL in your own site. When framed the
page hides its own header, makes its background transparent, accepts
`{type: "fk:theme", theme: "light" | "dark"}` via `postMessage` to pin a scheme
(remembered across in-frame navigation), and posts `{type: "fk:height", height}`
after every layout change so the host can size the frame:

```html
<iframe id="fb" src="https://feedback.example.com/board/myapp" style="width:100%;border:0" scrolling="no"></iframe>
<script>
  const fb = document.getElementById("fb"), origin = "https://feedback.example.com";
  addEventListener("message", (e) => {
    if (e.origin === origin && e.data?.type === "fk:height") fb.style.height = Math.ceil(e.data.height) + "px";
  });
  fb.addEventListener("load", () => fb.contentWindow.postMessage({ type: "fk:theme", theme: "light" }, origin));
</script>
```

---

## Branding

Every public page and the in-app form and board show a "Powered by Nuke" badge:
a speech bubble holding three rising bars. The name lives in two constants,
`BRAND` in `worker/src/html.ts` and `FeedbackBrand.name` in
`Sources/FeedbackKit/Views/FeedbackBrand.swift`. Change both together.

---

## Development

```sh
# Worker
cd worker
npm install
npm run db:migrate:local
npx wrangler d1 execute feedbackkit --local --command \
  "INSERT INTO apps (id, name, bundle_id) VALUES ('example', 'FeedbackKit Example', 'dev.feedbackkit.example')"
npm run typecheck
npm run dev                        # http://localhost:8787

# Smoke test
TOKEN=$(curl -s -X POST localhost:8787/api/register -H 'content-type: application/json' -d '{"app":"example"}' | jq -r .token)
curl -s -X POST localhost:8787/api/submit -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"requestId\":\"$(uuidgen)\",\"kind\":\"idea\",\"title\":\"Add a dark icon\",\"body\":\"The current icon is hard to see on dark home screens.\"}"

# Package
swift test                                                         # macOS, 40 tests
xcodebuild -scheme FeedbackKit -destination 'platform=iOS Simulator,name=iPhone 17' test

# Example app (talks to http://localhost:8787; no ATS exception needed)
open FeedbackKit/FeedbackKitExample.xcodeproj
```

Schema changes go in a new `worker/migrations/000N_*.sql`, applied with
`npm run db:migrate:local` / `:remote`. Push notifications and arbitrary file
attachments are deliberately not part of the system.
