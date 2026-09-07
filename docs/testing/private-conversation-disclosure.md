# Private conversation disclosure browser evaluation

Run the production API, admin UI, Postgres queue, real worker execution path
and a deterministic OpenAI-compatible mock together:

```powershell
$env:DATABASE_URL = 'postgresql://nessie:nessie@127.0.0.1:55432/nessie_disclosure'
pnpm --filter @nessie/admin test:e2e:disclosure
```

The evaluation owns one randomly named Nessie organization and deletes it on
completion. It opens headless Chromium at `http://localhost:5455` and writes
screenshots to `e2e/screenshots/disclosure/`. It refuses to adopt an already
running API or admin server, so run it before other fixed-port browser suites.
CI does this after its build, migration and Chromium setup, before navigation,
project-usability and connected-mail browser suites.

It seeds an ordinary team-shared agent owned by A, a private source chat whose
author is B, and a public Team launch channel containing C. B's Czech,
informal, misspelled private source is consumed by the real worker, which uses
the mock model's `send_message` call to post a group update. The mock utility
lane scripts a declined judgement for B's first informal request and a positive
judgement for B's separate explicit Czech request. Nessie itself makes no text
match or language-specific decision.

The current case verifies that A is an API-resolved organization owner (rather
than relying on its token claim), the restricted group message has B's exact
basis; C cannot see it in the transcript, search, or realtime event; unrelated
public group content remains visible; agent detail and run-tool read routes do
not expose the private source; and neither C nor owner A can grant B's
disclosure. B then uses the rendered **Share this reply** control, after which
only that message is granted to the destination channel. The raw private source
still does not appear in C's UI, SSE frames, search result, or inspected read
routes. B's explicit private request then creates the same exact
message-and-channel grant automatically, without a redundant UI click or a
standing grant.

The mock proves the full pipeline's routing, provenance, authorization and UI
effects. It does not demonstrate that a live model understands Czech or slang;
a live-provider eval is required for that claim.

On a failed browser assertion the runner writes a sanitized recipient page-text
capture and error detail. It saves a failure screenshot only if the page has no
private source or restricted-reply canary, so the artifact path cannot become a
second disclosure route.
