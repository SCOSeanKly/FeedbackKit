# Ask: the in-app helper

Answers "how do I do X?" inside any app registered on this Worker, from that app's own knowledge.
Not trained: every question sends the app's whole knowledge text to Claude as a cached system prompt.
Built 31 October 2026 on the `ask` branch. **Not deployed until you do the steps below.**

## What was added (all additive: no existing table, route or behaviour changed)
| Piece | Where |
|---|---|
| 4 new tables: `ask_config`, `ask_knowledge`, `ask_log`, `ask_usage` | `worker/migrations/0007_ask.sql` |
| Routes: app, web visitors, publishing, admin reads | `worker/src/routes/ask.ts` |
| Prompt, reply parsing, history clean-up (pure, unit-tested) | `worker/src/ask-core.ts` |
| Two new rate-limit bindings | `worker/wrangler.toml` |
| Swift: `AskView`, `FeedbackClient.ask / askConfiguration / rateAskAnswer`, optional "Check for an answer first" in `FeedbackForm(askFirst:)` | `Sources/FeedbackKit/` |
| Tests | `worker/test/*.test.mjs` (`npm run test:ask`), `Tests/FeedbackKitTests/AskClientTests.swift` |

## Deploying (in this order; each step is safe on its own)
1. **Merge and push** the `ask` branch, then tag a release (e.g. `1.1.0`) so apps can pick up `AskView`.
2. **Migrate** the live database (adds tables only): `cd worker && npm run db:migrate:remote`
3. **Secrets** (type each into your own terminal; never paste them into chat):
   `npx wrangler secret put ANTHROPIC_API_KEY` (the `sk-ant-...` key; set a spend limit in the Anthropic console too),
   `npx wrangler secret put ASK_PUBLISH_TOKEN` (any long random string, e.g. `openssl rand -hex 32`),
   optionally `npx wrangler secret put ASK_EVAL_TOKEN` for the answer-quality test runner.
4. **Deploy** the Worker: `npm run deploy`. Existing feedback endpoints are untouched; `/api/ask` stays closed
   ("not available") for every app until step 5.
5. **Publish NuKey's knowledge and settings** from the NuKey repo:
   `ASK_PUBLISH_TOKEN=... python3 Scripts/helper/publish_kb.py`
   (`--dry-run` first to see what is sent). This switches Ask on for `nukey` only.
6. **Check it**: `curl -s https://feedback.nukeyapp.com/api/ask/web/nukey -H 'Origin: https://nukeyapp.com' -H 'content-type: application/json' -d '{"question":"How do I turn off autocorrect?"}'`
7. **Point the website at Nuke**: `ASK_BACKEND=nuke python3 Scripts/docs/build_docs.py`, then publish the site.
8. **Switch the app to the native view** (needs step 1's release): update the FeedbackKit package in Xcode, then in
   `FeedbackHubSheet` replace the Safari sheet with `AskView(client:guideURL:onContactSupport:)` and pass
   `askFirst: AskBeforeSending(guideURL:)` to `FeedbackForm`.
9. Retire the standalone `nukey-helper` Worker only after steps 5 to 8 have been working for a while.

**Rolling back:** `npx wrangler rollback` restores the previous Worker version. The migration only adds tables, so
it never needs undoing. A bad knowledge publish is undone by publishing the previous text again (the last 5
versions are kept in `ask_knowledge`).

## Adding another app (WallBoard, mLite, ...)
1. Give it a knowledge folder and a build script that writes one markdown file (NuKey's is `Scripts/helper/build_kb.py`).
2. `PUT /api/ask/publish/<app>/config` with `productName` (required the first time), `assistantName`, `description`,
   `supportHint`, `extraRules`, `suggestions`, `webOrigins`, and its caps. `enabled: true` switches it on.
3. `POST /api/ask/publish/<app>/knowledge` with `{ body, guides }`.
4. In the app: `AskView(client: ...)`. That is all.

## Limits and cost
Per app, per day, split app vs web (`daily_cap`, `web_daily_cap`), per installation per hour and day, plus a burst
limit at the edge. Knowledge is cached, so a conversation pays full input price once. Token use per day is in
`ask_usage` and `GET /admin/api/ask/<app>/usage`.

## Reviewing quality
`GET /admin/api/ask/<app>/log?helpful=0` lists answers people marked unhelpful. Fix the guide or audit note, never
the prompt. Run NuKey's `Scripts/helper/eval/run_eval.py` after every change.
