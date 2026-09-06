# Browserbase cloud browsers — adversarial reviews (2026-09-02)

Two chapters of [2026-09-02-browserbase-cloud-browsers.md](2026-09-02-browserbase-cloud-browsers.md) (§5c and §6a), moved here verbatim to keep that plan under the repo's file-length cap. Section numbers are the parent's.

## 5c. Adversarial code review (Kimix, 2026-09-02) — what it found

Nine defects confirmed and fixed; the review paid for itself twice over.
The two that mattered most were both cases where a guard existed but did not
cover the path that reached it:

- **A scheduled run could bill somebody's personal Browserbase account.** The
  durable-browser path loaded its connection by id and skipped the requester
  check the ephemeral path makes, and the only unattended guard keyed on
  login *count* — zero logins meant no refusal. Now the durable arm requires
  organisation scope whenever there is no requester: whose money it is does
  not depend on what is signed in.
- **`press` was not a write**, so the gate refused `type` and `click` on a
  foreign origin and then let the model press Enter to submit the very form
  it had just protected. Enter and Space are activations; the rest of the
  closed key list stays a read.

Also fixed: the release claim was not exclusive (`releasing` was itself
claimable, so two of the three writers could both call Browserbase and the
loser's failure path overwrote the winner's row); `unknown` — the state a
*failed* remote stop leaves — was never reaped, so the row most likely to be
costing money was the one nothing retried; the origin gate trusted a cached
URL that a self-redirecting page invalidates, and now asks the browser;
concurrent `acquireCdp` opened rival sockets, and a second automation
connection can itself end the session; a reset could tombstone a browser
between check and insert, so both the session insert and the reconciler now
re-check; a post-open failure stranded a live session while telling the model
nothing had opened; and hand-back marked a session authenticated, after which
only the *run requester* could see it — hiding a signer's own logged-in page
from them while showing it to somebody who never signed in.

One finding was rejected: `authSecret ?? ''` is unreachable (the API exits in
hosted mode without a secret and generates one in local), so it is not a
known-empty encryption key. Three were noted rather than changed — the
optional-chained disclosure sink is fail-open by shape but its optionality
belongs to a shared type, and the bind-guard TOCTOU and null approver on
unattended runs are real but narrow.

The orphaned-context claim was fixed by making the comment honest: no sweep
can find a context with no row, so a failed cleanup now logs the context id
loudly for the account holder rather than pretending to be recoverable.

Not verified against a live Browserbase account: no key was available, so
the durable-context path (create, attach with `persist`, delete) is covered
by unit and Postgres tests against a faked client, not an end-to-end run.

**Phase 3 — unattended logins + polish.**
Per-login per-trigger opt-in for scheduled runs (org connection only),
proxy/geo options, Stagehand-style `browser_act` if observe/act proves too
low-level. Separately tracked, not this plan: the disclosure preconditions
that let `browser.connected.*` be advertised.

## 6a. Adversarial-review addenda (2026-09-02, Kimix + Codex Sol)

Accepted findings that are requirements rather than section rewrites:

- **Non-idempotent actions get the executor's ambiguity protocol.** A click
  can place an order and then lose the CDP response; the device transport
  already handles this with a stable per-tool-call idempotency identity
  and a fatal unknown-outcome error (`executor-toolset.ts`) — the cloud
  dispatch mirrors it: never silently retry an action whose outcome is
  unknown, never report it failed when it may have happened.
- **A pinned WSS dial is new work, not a reused precedent.** The MCP SSE
  transport rides HTTP `safeFetch`, and the raw pinned connector returns a
  TCP socket without a TLS/WebSocket handshake — `@nessie/browser-cloud`
  builds the resolve-pin-then-TLS(SNI)-then-upgrade client as its own
  deliverable on the `url-safety.ts` primitives. `browser_goto` also
  refuses non-http(s) schemes, matching the executor's egress posture
  (navigation egresses from Browserbase's network, so the SSRF surface is
  theirs, but scheme hygiene is ours).
- **"Sign out & reset" is authorized and honest.** Reset is available to
  the agent's steward/owner and to any recorded signer (their own
  revocation right) — not to every member, or it is a one-click DoS on a
  team's logins. It first force-releases any active session through the
  ordinary claim, and the copy says both truths: it wipes *all* logins
  (per-service selective sign-out via CDP cookie deletion is phase-3
  polish), and it does not revoke the service's own server-side session —
  fully revoking means the service's own security page too.
- **Unattended opt-in granularity is the browser, not the login.** One
  context carries every service's cookies at once, so a per-login
  per-trigger opt-in would be audit metadata pretending to be a boundary;
  phase 3's opt-in is per-browser and the copy says which services ride
  along.
- **One context per agent is a recorded trade.** Browserbase recommends a
  context per site identity (large contexts slow sessions; one poisoned
  context takes every login down). v1 keeps one context per agent for the
  Grok-parity mental model and revisits if session startup degrades —
  the escape hatch is per-service contexts behind the same tools.

