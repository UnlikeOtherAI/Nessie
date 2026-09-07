# Horizontal scaling — nothing a second instance cannot see

Authoritative standard for running N copies of the API, the worker and the
gateway. [`AGENTS.md`](../../AGENTS.md) → "Architecture" carries the one-line
invariant and points here; **this file is the rule.**

Nessie is closer to horizontally scalable than its single-container deployment
suggests: the queue, realtime fan-out, scheduled triggers, thread
serialisation, exactly-once sends, OAuth flows and executor daemons were all
built on Postgres primitives that already work across instances. What blocks
running two copies is a bounded list of concrete defects, audited with
`file:line` evidence in
[`docs/plans/2026-09-05-horizontal-scaling-statelessness/audit.md`](../plans/2026-09-05-horizontal-scaling-statelessness/audit.md)
and scheduled in
[`overview.md`](../plans/2026-09-05-horizontal-scaling-statelessness/overview.md).
Each rule below is written after one of them. Audit numbers in parentheses are
that file's finding numbers; line numbers are as of `e064a136`.

## Table of Contents

The nine invariants keep their numbers wherever they moved, because the codebase
cites them by number.

- [Process lifecycle](process-lifecycle.md) — 1 no module-scope mutable state,
  5 boot connects and listens, 6 `SIGTERM` drains within the grace,
  8 instance identity is a UUID minted at boot.
- [Work durability](work-durability.md) — 2 every periodic job claims its work,
  3 every enqueue carries an idempotency key, 4 every long-running handler is
  resumable.
- [Storage and realtime](storage-and-realtime.md) — 7 no local disk beyond
  per-request scratch, 9 realtime publishes under a per-scope lock.

## How to verify

- **`infrastructure/compose/docker-compose.multi.yml`** — an override that runs
  `api` × 2 and `worker` × 2 against one Postgres and one MinIO, with Caddy
  round-robining the API. **`pnpm dev:multi`** brings it up locally.
- **CI job `multi-instance-smoke`** — the mock-LLM smoke driven through that
  two-instance stack, plus a chaos step that sends `SIGTERM` to one worker
  mid-run and one API mid-stream and asserts: no duplicate messages, no run
  left in `running`/`waiting_approval` without a live lease, a crash checkpoint
  left for the successor, and a resumed SSE stream that loses nothing in the
  sense above. All four pass; the step stays advisory only because kill timing
  on a shared runner is not a signal worth blocking every PR on.
- **Every PR that fixes a finding extends that smoke with the scenario that
  would have caught it**, and takes its file off the lint allowlist below in
  the same change.

The harness and the CI job are Phase 0.3 and 0.4 and land beside this file;
until they do, the names above are the contract, not a description.

## The ratchet

The root [`eslint.config.js`](../../eslint.config.js) carries a
horizontal-scaling block over `api/src/**/*.ts` and `worker/src/**/*.ts`. Like
the egress block it sits beside, **the lint is not the boundary** — Postgres is,
and this file is the rule. It exists so the tree cannot quietly grow a new
per-process authority while Phases 1–5 remove the ones that exist.

It bans two things at module scope: `let` (a memo, a cached client or a
did-we-already-do-this flag is per process by definition) and a **zero-argument**
`new Map()`/`new Set()`/`new WeakMap()`. The argument count is what separates a
store from a constant: a mutable store is created empty and filled at runtime,
while `new Set(['a', 'b'])` is a frozen lookup table and stays legal, as does an
empty collection annotated `ReadonlySet`/`ReadonlyMap`, which cannot be filled
through that binding.

Two things the ratchet does **not** catch, stated so a green lint is not read as
a proof: the selectors anchor on the program root, so per-process state held in
a closure inside a once-per-process factory is invisible to them —
`bootstrapTokenState` (1.2) and the `buckets` map inside the rate limiter (1.3)
are both that shape and neither trips the rule. Widening to every function-scoped
`let` would flag the whole tree. Judge new code against the invariants above, not
against the lint.

Every current offender is on an explicit allowlist in that block, each entry
carrying either the audit finding that owns its fix or the reason it is
genuinely per process. **The allowlist only shrinks.** A file leaves it in the
change that removes its last offense; a file joins it only with a finding number
or a per-process justification written beside it.
