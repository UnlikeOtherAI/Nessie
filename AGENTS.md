# Nessie Agent Standards

## Rule zero — a capability is not done until a person can reach it

This is the standard every other one serves. Nessie's recurring failure is not
missing features; it is finished features nobody can get to, and screens padded
with data that answers no question. A project's documents existed for months but
were not *in* the project. Run timing, scheduled triggers, the audit-chain
verifier, the whole execution-runner subsystem — all shipped, none reachable
from anywhere in the UI. That work counts as unfinished.

Four checks, applied to every change that adds or alters a capability:

1. **Name the home and the doorways.** Every capability has one owning surface
   *and* at least one in-context entry point on the screen where a person is
   standing when the question arises — a link, a badge, an inline row, a tab. If
   you cannot name both in the same turn, the feature is not finished. One page
   that nobody has a reason to open is not a surface.
2. **Scope by entitlement, never by ambient context.** Show what the caller is
   allowed to see, decided by the access rules. Do not narrow a list by whatever
   the session claim happens to say — a session's project/team is an accident of
   how the account was created, not a statement about what the person may read.
   Narrowing is an explicit filter the caller asks for, never a silent default.
   (This exact mistake hid people's own documents and made the admin seed
   duplicate spaces beside the real ones.)
3. **Every element names the decision it drives.** If you cannot say which
   decision or action a number, row, or chip enables, cut it. Prefer a short
   screen that is all signal. Owner-only operational telemetry never appears on
   a member-facing surface, and customer billing never renders beside local
   ops telemetry (see the `/tokens` vs `/ops/usage` split).
4. **Reuse the surface; never fork it.** When the same thing must appear in two
   places, it is one component parameterised by scope — as the project Docs tab
   reuses the knowledge workspace. A second implementation of the same view is a
   defect, not a feature. The same holds one level down, for controls: the
   admin's single-select strip is `components/primitives/TabBar.tsx` and nothing
   else. It had drifted into nine look-alikes (`.admin-tab`, `SegmentedControl`,
   `IntegrationTabs`, six inline ones) that disagreed on shape, colour, counts,
   and ARIA; they were collapsed into one on 2026-08-29. The identity picture is
   the same story one level down: `components/primitives/IdentityTile.tsx` draws
   every avatar, its radius is a function of the rendered size rather than a
   `rounded-*` class, and an agent's picture resolves from its id through one
   directory — seventeen hand-rolled tiles across twelve radii were collapsed
   into it on 2026-09-02, which is also what stopped the Personal Assistant
   rendering as a portrait in the sidebar and a lightning bolt in the thread
   panel. See `CLAUDE.md` → "Theming / design system".

A new server capability ships with its surface in the same change, or with a
deliberate, written decision that it is machine-only. "The API exists" is not a
delivery.

## Navigation — one framework

Anything that moves a person between screens, opens an overlay, or handles
Back goes through the navigation framework — read `docs/navigation/overview.md` first.
It is the only way, and adding a second one is the defect Rule zero names.

## Workflow

- Worktrees are mandatory. The main project checkout always stays on `main`; never edit it directly. Every task — and every parallel agent/CLI — works in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never reset, clean, or discard another worktree's or agent's work. When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked. After merge, in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch.
- Commit and push after every turn. No exceptions. If there is nothing to commit, skip.
- Local dev runs with hot reload via `pnpm dev` (root) — API (5454, nodemon) + admin (5455, Vite HMR) in parallel. (Moved from 5554/5555 to dodge an Android emulator squatting on those ports; production internal port stays 5554.) Admin and API source edits reload automatically; **do not hand-build the admin to see changes.** The repo sits on a macOS data-volume path where fsevents is dead, so watchers must poll: Vite `server.watch.usePolling` and `nodemon --legacy-watch`. Don't remove these.
- Desktop installable builds that embed local admin changes must build admin with `VITE_API_BASE_URL=https://api.nessie.works` and Tauri with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. `https://app.nessie.works` is the admin web origin, not the API origin; using it as `VITE_API_BASE_URL` leaves login stuck at "Loading providers...". See `docs/running-the-apps.md`.
- **Build:** Install a release on the named device.
- Mac App Store/TestFlight builds use `pnpm --dir desktop run tauri:build:appstore`, a Mac App Store Connect provisioning profile supplied through `NESSIE_DESKTOP_APPSTORE_PROFILE`, `NESSIE_DESKTOP_SIGNING_TEAM_ID`, and an `APPLE_SIGNING_IDENTITY`. The store configuration is sandboxed and deliberately excludes the packaged executor runtime; the Developer ID build remains the executor-capable distribution. See `docs/running-the-apps.md`.
- **macOS release-signing policy:** Never build, sign, install, or present an ad-hoc-signed macOS bundle unless Ondrej explicitly asks for an ad-hoc build. A distributable build or any build intended to test executor controls must use the configured `Developer ID Application` identity, `--options runtime`, and the matching `NESSIE_DESKTOP_SIGNING_TEAM_ID`. Before installing it, verify `codesign --verify --deep --strict` and confirm both `Authority=Developer ID Application:` and the expected `TeamIdentifier`. If that certificate or private key is unavailable, report the blocker and leave the currently installed app intact; a Mac App Store/TestFlight certificate is not a substitute because it deliberately omits the executor runtime.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- `pnpm --filter @nessie/admin build` is for production/CI bundles only, not the dev loop.
- Root `pnpm build`, `make build`, and production Dockerfiles are lint-gated. Do not replace them with raw build commands unless the replacement keeps an equivalent lint gate. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.
- Root `pnpm build` and `pnpm typecheck` generate the Prisma client once, run
  Turbo with `@nessie/cli` excluded, then compile/typecheck the CLI through its
  prepared task. This keeps every generator outside the concurrent phase:
  concurrent generators can temporarily erase Prisma exports while sibling
  packages compile. The standalone `@nessie/cli` build/typecheck stays
  self-contained and may generate before its own compilation. CI must call the
  lint-gated root build; container flows that call Turbo directly must generate
  once in an earlier serialized step.
- Prisma migration folders under `api/prisma/migrations/` are immutable once committed: never rename, renumber, delete, or edit one. `pnpm lint:migrations` (part of root `pnpm lint`) enforces this against the merge-base and warns on non-`CONCURRENTLY` index creation on `messages`/`task_events`/`runs`/`audit_logs`. The `upgrade-path` CI job restores the checked-in baseline fixture (`api/prisma/upgrade-fixtures/baseline.sql.gz`, regenerable via `scripts/generate-upgrade-fixture.mjs`) and proves `prisma migrate deploy` from HEAD converges it; see `docs/deployment.md` "Supported upgrade paths".
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.
- Run package tests through Turbo (`pnpm test`, or `pnpm exec turbo run test --filter=<pkg>`), not `pnpm --filter <pkg> test`. Tests import sibling packages through their `dist` exports, so only the Turbo path guarantees the `^build` that CI's "Build shared packages" step performs. Invoked directly, a package's tests run against whatever `packages/*/dist` happens to be on disk, and a missing build surfaces as `ERR_MODULE_NOT_FOUND` rather than a test failure.
- **Export `DATABASE_URL` for that Turbo run, or the database suites do nothing.** Turbo runs in strict env mode, so a task only sees variables it declares; the `test` task declares `DATABASE_URL` (and `NESSIE_TEST_PRISTINE_DATABASE`) in `turbo.json` for exactly this reason. Every Postgres-backed suite gates on `process.env.DATABASE_URL ? test : test.skip`, so with the variable unset they report `# SKIP` and the run is green with zero database coverage — 47 skipped in `@nessie/api` alone. The `test` task is also `"cache": false`: its result depends on a database Turbo cannot hash, so replaying a cached pass over a database that has since been reset or re-pointed would be a false green.
- **`@nessie/api#test` is ordered after `@nessie/worker#test` in `turbo.json`, deliberately.** Plain `test` depends only on `^build`, so Turbo — unlike topological `pnpm -r` — would otherwise run both packages' database suites at once against the one database. `worker/test/db` drives the global queue pollers and refuses to start on a database holding rows they would claim, while api's trigger-dispatch suites legitimately pass through exactly that state; one orphaned `(agent, thread)` pending pair held open fails all four worker DB tests. Do not remove the ordering to reclaim the few seconds of parallelism.
- `node --test` forks **one child process per test file** (~77 MB each), and Turbo runs up to 10 package tasks at once, so a whole-repo `pnpm test` over 295 test files can hold ~100 concurrent node processes — several GB, enough to push a developer machine into swap. Pure unit suites should therefore set `--experimental-test-isolation=none` (Node 22.8+, so it is safe on CI's Node 22) to run every file in a single process, as `@nessie/admin` does. Only use it where files share no process-level state — suites that touch Postgres or mutate module state need the default `process` isolation; cap those with `--test-concurrency` instead. `@nessie/worker`'s unit suite is the example: its 92 files mutate module state, so `test:unit` runs with `--test-concurrency=4` — unbounded it forks all of them at once (~110 MB of tsx-loaded import graph per child, several GB at peak) and under machine load the OS kills a child, which surfaces as a bare `'test failed'` with no assertion output.
- A test file reported as failed with only `'test failed'` and no assertion output is node's message for a **child process that exited non-zero or was killed by a signal** — commonly the OS reclaiming memory, not a real test failure. Re-run with `--test-reporter=tap`, which prints that child's `exitCode`/`signal`.
- **Postgres-backed suites share one database and run concurrently.** `node --test` runs files within a package in parallel, so a DB-backed test is never alone — several api suites create and delete organizations at the same time. Cross-package overlap depends on how the suites are invoked: CI's `pnpm -r --if-present test` is topological and `@nessie/api` depends on `@nessie/worker`, so worker finishes before api starts (an accident of the dependency graph — do not rely on it), and `turbo run test` reproduces that order only because `turbo.json` pins `@nessie/api#test` behind `@nessie/worker#test` by hand. Running the two packages' test scripts in parallel yourself still overlaps them, and so does any *new* database suite added to a third package — `packages/runtime` and `packages/memory` already have some, and they are safe only because they create no rows the global pollers claim. Under any of them:
  - **Never write a global mutation.** `DELETE FROM queue_jobs WHERE idempotency_key LIKE 'run:batch:%'` matches every suite's jobs, not the caller's — it deletes a row another suite is about to count. Scope cleanup to the seed (every `run.execute` payload carries a top-level `threadId`: `DELETE FROM queue_jobs WHERE payload->>'threadId' = $1`).
  - **Never assert a global count.** `sweepPendingThreadMessages` drains every orphaned `(agent, thread)` pair in the database and `dispatchNextMailboxMessage` claims the globally oldest queued mailbox row; neither takes a tenant filter. Assert the seed's own outcome instead of the poller's return value.
  - **Never *depend* on a globally-scoped production lookup either.** Asserting on the global scope is only half of it: a test also breaks when the code under test reads it. `resolveUoaWorkspaceContext` used to resolve "the shared organization" as the globally oldest `Organization` row (right in production — one org, never deleted; unstable in a test database where a dozen suites create and delete organizations): a suite that seeded its own organization still got a *foreign* one back, and died on a foreign-key violation the moment that suite's cleanup deleted it. The UOA path now resolves 1:1 by `Organization.externalOrgId` — deterministic per suite by construction (`api/test/workspace-context-postgres-race.test.ts` no longer anchors an epoch-dated org) — but the oldest-org lookup survives for the legacy no-workspace/generic-OIDC path, so the rule stands: make such a lookup resolve the seed deterministically and assert that it did, so the precondition is stated rather than assumed.
  - **A suite that drives a global poller needs an exclusive database.** Unique per-suite ids are not enough — a foreign `queued` mailbox row is claimed ahead of the suite's own. Those suites live in `worker/test/db/`, run via `pnpm --filter @nessie/worker test:db` with `--test-concurrency=1` (one file at a time), and call `assertGlobalQueuesQuiet` first, which fails fast with an actionable message rather than dispatching a real database's mail. `test:unit` globs `test/*.test.ts`, so the directory itself is the split.
  - **Timestamps are `timestamp(3)` and Postgres *rounds* into them.** Back-to-back inserts tie on `created_at` (5 rapid inserts typically record ~3 distinct values), so a test that asserts an exact arrival order must set the order explicitly rather than race the clock. Rounding also puts a just-inserted `visible_at` up to ~0.5 ms in the *future* versus full-precision `now()`, so a row can be briefly invisible to a `visible_at <= now()` poller — real pollers loop, single-shot tests must seed an explicitly past `visibleAt`.
- **A cast Prisma fake is unityped, so a query it does not model fails as a runtime `TypeError` — extend the fake in the change that extends the query.** `as unknown as PrismaClient` silences the compiler, so a delegate or a nested relation the fake omits is `undefined` at call time, not a type error. Both shapes have shipped red to `main`: project avatars became a published attachment reference and `prisma.project.count` took five attachment-ACL tests down with `reading 'count'`; and `team.findMany`/`findFirst` returned flat rows while production read `team.project.organization.name` and `…organization.members[0].role`, which login wrapped as a 401 `EXTERNAL_AUTH_FAILED` so the shape mismatch never named itself. The rule follows the disclosure-sink one: the obligation sits on the *query*. Adding a counted reference, a `select`ed relation, or a new delegate means teaching the fake in the same commit — and a fake that honours `select` must honour the `where` beside it, or it widens the result set while it is at it. Prefer asserting the new case too (`api/test/attachment-unlinked-access.test.ts` had no project-avatar case at all).
- Mock-LLM harness: deterministic scripted inference for tests lives in `@nessie/mock-llm` (`packages/mock-llm`, scenario JSON + in-process `runInference` adapter + OpenAI-compatible HTTP server). `pnpm --filter @nessie/worker test:smoke` runs the full-pipeline CI smoke (seeded Postgres → enqueue → loop → tool call → completion); `pnpm --filter @nessie/worker test:load --runs N --workers W` runs the load mode. See `docs/mock-llm-harness.md`.

## Ports — NON-NEGOTIABLE


- **API**: `5454` (local dev) — always. Do not kill or restart without restarting on the same port.
- **Admin**: `5455` (local dev) — always. UI verification MUST use `http://localhost:5455`.
- Never use any other port for these services in local dev.
- Moved from 5554/5555 on 2026-06-11 because an Android emulator (`gpteen_api34`) squats on 5554/5555 — see the emulator-port-conflict memory.
- **Production is unchanged:** the API container's internal port stays `5554`, pinned via `NESSIE_API_PORT` in `infrastructure/compose/docker-compose.prod.yml` (behind the shared Caddy proxy). Only local dev moved.

## Dev mode (hot reload)


- `pnpm dev` (repo root) = `turbo run dev --parallel`: API (5454, nodemon) +
  admin (5455, Vite HMR). Polling watchers are mandatory and must stay — see
  `AGENTS.md` → "Workflow" for why (fsevents is dead on this volume).
- After starting/restarting a dev server, verify it: hit `GET /health` (5454)
  and `GET /` (5455), and confirm `@vite/client` is present in the served
  admin HTML.

## Build (production / CI)


- `pnpm --filter @nessie/admin build` produces the static admin bundle
  (`dist/`); `pnpm --filter @nessie/admin preview` serves it. Prod/CI only —
  use `pnpm dev` for the local loop.
- **Build:** Install a release on the named device.
- Worker rebuilds after worker edits, desktop/App Store builds, lint-gated
  root builds, Prisma generation ordering, migration immutability, and all
  test rules (Turbo invocation, `DATABASE_URL`, DB-suite discipline):
  `AGENTS.md` → "Workflow".

## Production deployment


- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers, reusing the host's shared Caddy edge proxy and Docker networks
  (`edge`/`db`). It is **not** GCP Cloud Run — the old GCP workflow/spec are
  retired ([docs/phase2-gcp-deployment-spec.md](docs/phase2-gcp-deployment-spec.md)
  is historical).
- URLs: public web `https://nessie.works`, admin `https://app.nessie.works`,
  API `https://api.nessie.works`. TLS is automatic (Caddy + Let's Encrypt);
  DNS is Cloudflare, DNS-only.
- Stack: `nessie-api` + `nessie-worker` (one `Dockerfile.app` image, command
  override) + `nessie-admin` (static nginx) + a dedicated `nessie-postgres`
  (pgvector — the shared Postgres lacks the `vector` extension). No Redis (queue
  and realtime are Postgres-backed). Mode is `selfHosted`; first login is the
  one-time bootstrap owner URL.
- Compose: `infrastructure/compose/docker-compose.prod.yml`. Redeploy with
  `infrastructure/compose/redeploy.sh` after rsync'ing to `/srv/nessie`.
- The API trusts `X-Forwarded-For` only when `NESSIE_API_TRUSTED_PROXY_HOPS`
  is set. Production behind Caddy sets it to `1`; local/dev defaults to `0`
  and ignores forwarded client IP headers.
- **Authoritative guide: [docs/deployment.md](docs/deployment.md)** — first
  deploy, redeploy, config reference, MCP secret store, and SSO status.

## Linting


- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## MDNS


The backend registers `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch. This feature is part of the legacy `src/` runtime; the new `api/` server does not yet register mDNS. Clients on the same network can discover the legacy server automatically without hardcoded IPs.

## Natural-language intent is model-judged — never string-matched

- Never detect user intent, addressing, relevance, sentiment, or meaning by
  string comparison, keyword lists, regexes, or phrase heuristics against
  message content. Understanding what a message means is always the model's
  job, so behaviour is natural and works in any language, with slang,
  misspellings, and informal phrasing.
- Deterministic code may act only on **structural facts** that require no
  interpretation of content: explicit @mention entities (structured
  references), channel membership/bindings/roles, message authorship (human
  vs agent) and type, budgets/cooldowns/rate limits, and run invariants.
- No "looks like a question" checks, no trigger-word lists, no language
  detection branches. Agent-facing replies and notices follow the user's
  language because the model infers it, not because code detects it.
- Test fixtures for engagement/intent paths must include non-English, slang,
  and misspelled inputs.

## Code Quality

- Strict linting. Builds must not pass without all lints passing.
- No patches on patches. No fallbacks unless required by functionality. Diagnose and fix root causes.
- Before reusing code that hasn't been reused before: pause, plan a refactor, execute it maintaining best architectural practices, then reuse.
- Code files: 500 lines max. Exceeding the cap is an architectural signal — split along cohesive responsibility seams via a real refactor, never by dumping into `-extras`/`-helpers` files.
- No over-engineering. Build the simplest thing that satisfies the current goal. No premature abstractions, no speculative generality, no backwards-compat shims unless functionality requires them.

## Documentation & Goals — update with every change

Every change must keep documentation and stated goals in sync with the code. This is part of the definition of done, not a follow-up.

- When behaviour, architecture, or a public contract changes, update the affected `docs/` document(s) in the same turn.
- When a change alters a project goal or scope, update the goal where it is stated (`docs/brief.md`, the relevant spec, and this file / `CLAUDE.md` if the standard itself changes).
- When a feature is removed or superseded, delete or move its doc to `docs/done/` — do not leave stale specs describing code that no longer exists.
- A change that touches the MCP surface, ports, build steps, or workflow must update `CLAUDE.md`/`AGENTS.md` accordingly.
- If a change has no documentation impact, that is fine — but the decision to skip must be deliberate, not forgotten.

## Verification

- Every UI change must be visually verified using Playwright before considering the work complete.
- Use Playwright (`mcp__plugin_playwright`, or a local Playwright script) to load `http://localhost:5455/<path>`, screenshot the affected page, and confirm the feature renders correctly.
- Always run Playwright headless unless the user explicitly requests otherwise.
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

**The codebase.**

- **API** (`api/`, port 5454) — multi-tenant REST control plane: auth (OIDC/session), channels, tasks, approvals, triggers, MCP connector management, token ledger, audit log
- **Worker** (`worker/`) — async execution service: agentic loop, task scheduling, trigger delivery, mailbox processing
- **Admin** (`admin/`, port 5455) — full product interface for operators and knowledge workers
- **Desktop** (`desktop/`) — Tauri shell for the hosted admin. Developer ID releases include the local executor; the sandboxed Mac App Store/TestFlight variant deliberately does not. Do not build, install, or present an ad-hoc-signed macOS bundle unless Ondrej explicitly requests one. Executor verification requires a `Developer ID Application` signature with the configured `NESSIE_DESKTOP_SIGNING_TEAM_ID`, validated with `codesign --verify --deep --strict` before installation; if that identity or its private key is unavailable, preserve the installed app and report the signing blocker.
- **Web** (`web/`) — public landing page only
- **Packages** (`packages/`) — shared runtime, scheduling, policy, and type libraries
- **Guardrails** ([docs/architecture.md](docs/architecture.md)) — things to avoid when creating files, organizing code, sharing logic, and preserving security/testability boundaries

Rules that apply wherever you are working are stated here in full. Rules that
belong to one subsystem are **routed**: this section names the invariant in a
sentence and links the file that states it completely.

**A routing entry is a signpost, not a summary you may implement against.** The
one-liner exists so you can tell whether the rule is in play; it deliberately
omits the identifiers, the failure it was written after, and the corollaries
that make it followable. When your change touches a routed area, open the linked
file first. Standards files live in `docs/standards/` and are authoritative;
when one changes, the same turn updates it, not this section.

- All standards, specs, and design decisions live in `docs/`.
- When a document is finished, move it to `docs/done/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the architecture guardrails and anti-pattern list in `docs/architecture.md` before creating files, reorganizing code, or reusing logic.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
- **Agent voice, reactions and the working marker.** Agents answer at
  colleague length, react rather than reply when a message needs registering
  but no answer, and paint 👀 on the message a run is working from.
  Read [`docs/standards/agent-voice.md`](docs/standards/agent-voice.md)
  before writing code here.
- **A recurring watch keeps one rolling status message.** A sweep that finds
  nothing edits the watch's own status line in place instead of adding a
  message, so ninety-six quiet sweeps a day stay one line.
  Read [`docs/standards/rolling-watch-status.md`](docs/standards/rolling-watch-status.md)
  before writing code here.
- **Theming and the design system.** All colour lives in
  `admin/src/styles.css` as tokens; one tab bar, one identity tile, one
  composer, one dialog shell, and no nesting.
  Read [`docs/standards/design-system.md`](docs/standards/design-system.md)
  before writing code here.
- **Calling the Personal Assistant (Gemini Live voice).** The API is a
  credential broker, not a media path: the client opens the constrained
  Gemini Live socket itself and audio flows device↔Google.
  Read [`docs/standards/voice-calling.md`](docs/standards/voice-calling.md)
  before writing code here.
- **Stack, agentic-loop run budgets and run lifecycle.** The stack itself, the
  run-budget model (metering, wind-down, checkpoints, compaction), budget
  threshold alerts, and the active-run lifecycle controls.
  Read [`docs/standards/tech-and-run-budgets.md`](docs/standards/tech-and-run-budgets.md)
  before writing code here.
- **UOA owns the org structure, not just the people in it.** Where UOA SSO is
  configured, its organisation and team hierarchy maps **1:1** into Nessie: one
  UOA organisation is one Nessie `Organization`, bound by the stable UOA
  organisation id (`Organization.externalOrgId`, unique), and one UOA workspace
  is one **workspace** (the local `Team` model) inside that organisation. A
  workspace IS the UOA team, not a container for one; Nessie's own Projects and
  Channels live INSIDE a workspace, and UOA has no concept of either. The model
  in full, including the currently inverted `Team.projectId` foreign key:
  [docs/standards/workspace-model.md](docs/standards/workspace-model.md).
  **Creating** either happens in-app against UOA's org API rather than by
  redirecting a person into its chooser for a second interactive login; the
  local rows are still born only in `materializeUoaWorkspace`, from what the
  silent switch grant proved
  (`docs/plans/2026-09-02-in-app-organisation-creation.md`). The standing gap
  between that and "no duplicated data at all" — three local membership tables
  against UOA's two, a Project level UOA has no concept of, and the delta/
  revocation machinery UOA still lacks — is mapped in
  `docs/plans/2026-09-02-uoa-as-a-service-unification.md`.
  Flattening several UOA organisations into one local container — the
  pre-2026-08-15 shared-org model — or keeping any second local copy of the org
  hierarchy is the same violation as duplicating identity rows, and gets the
  same remedy: an API-backed refactor plus a data migration, never a
  compatibility copy. The org name is UOA's mirror, so a **rename is a relayed
  `PUT /org/organisations/:orgId` write**; an install with no IdP keeps one
  unbound organisation (`externalOrgId` null). Budgets, policies, audit, the member directory, and org settings
  therefore scope per UOA organisation. Model, migration, and verification:
  `docs/plans/2026-08-15-uoa-org-tenancy.md`; the rule itself lives in
  `docs/brief.md` → "Current SSO identity invariant".
- **Personal-assistant tools and route mirroring.** A PA tool that does what a
  person does by clicking calls the same function that person's button calls,
  and mirrors that route's authorization exactly.
  Read [`docs/standards/personal-assistant-tools.md`](docs/standards/personal-assistant-tools.md)
  before writing code here.
- **Global agents, specialist delegation and `agent_handoff`.** App-provided
  agents are blueprints in code, one `systemManaged` row per organisation,
  reachable through a per-user single-agent DM.
  Read [`docs/standards/global-agents.md`](docs/standards/global-agents.md)
  before writing code here.
- **Disclosure boundaries — what an agent read decides who may read its answer.**
  Every read that enters a run's context feeds the `ConsumedSourceSink` in the
  same change; an empty basis means unrestricted, so a forgotten read fails
  open.
  Read [`docs/standards/disclosure-boundaries.md`](docs/standards/disclosure-boundaries.md)
  before writing code here.
- **Agent ownership, visibility and edit authority.** An agent belongs to a
  person, the org tree is a read-time JOIN, and ownership — not the org-owner
  role — decides who may edit which field.
  Read [`docs/standards/agent-ownership.md`](docs/standards/agent-ownership.md)
  before writing code here.
- **Agent chat cards.** One card system with a closed block vocabulary; the
  press is claimed once by a conditional UPDATE and writes a real user message.
  Read [`docs/standards/agent-cards.md`](docs/standards/agent-cards.md)
  before writing code here.
- **Live document streaming.** Streaming taps the model's own tool-call
  arguments; the live lane never touches durable storage, and editing is deltas
  rather than a rewrite.
  Read [`docs/standards/live-document-streaming.md`](docs/standards/live-document-streaming.md)
  before writing code here.
- **A capability that can stop working owns the way a person finds out.**
  Classify the failure into a state that names its remedy, persist the reason,
  and alert exactly once per transition; recovery is explicit, never
  auto-healed at login.
  Read [`docs/standards/capability-health-alerts.md`](docs/standards/capability-health-alerts.md)
  before writing code here.
- **A tool declares where it belongs; no surface guesses.**
  `BuiltinToolDefinition.category` is required and its vocabulary is
  `TOOL_CATEGORIES`; no surface infers a category from an id prefix.
  Read [`docs/standards/tool-categories.md`](docs/standards/tool-categories.md)
  before writing code here.
- **An agent's mailbox is its own store.** Hosted agent email keeps mail in its
  own tables with one backing channel per mailbox; routing, claiming, waking
  and the send gate are all structural.
  Read [`docs/standards/agent-email.md`](docs/standards/agent-email.md)
  before writing code here.
- **A connected mailbox is somebody else's store.** An agent working in a
  mailbox somebody connected over SMTP/IMAP reaches it only through two
  separate decisions — a per-`(connection, agent)` access row and, for a
  personal mailbox, the effective user — and every send is approved and pinned.
  Read [`docs/standards/connected-mailboxes.md`](docs/standards/connected-mailboxes.md)
  before writing code here.
- User-authored MCP connectors may use HTTP/SSE remote endpoints only. Cloud-side stdio process execution is disabled at catalog, instance, dispatch, and worker boundaries; HTTP/SSE/OAuth URLs must pass the SSRF guard. Use remote MCP runners for private networks or local machines.
- **Outbound egress is IP-pinned, not just validated.** Validating a URL and
  then calling plain `fetch` leaves a DNS-rebinding window between the check and
  the socket. Use `@nessie/runtime` `safeFetch` (or `pinnedFetch` when you
  handle redirects yourself) for anything reaching a caller-, operator- or
  model-supplied address: it resolves once, pins the connection to the vetted
  IPs, re-checks each address as it dials, and re-validates every redirect hop.
  `assertSafeUrl` alone is only enough where nothing is fetched afterwards.
  Current callers: MCP OAuth exchange/refresh/discovery/registration, the MCP
  SDK HTTP+SSE transports, FCM `token_uri`, `web_fetch` and `http_fetch`.
  Inference provider `baseUrl` is validated at write time as well as use time.
  Raw sockets get the same policy through the same rules rather than a second
  copy of them: `resolveVettedAddresses` is the shared host check, and the
  IMAP/SMTP dialer (`packages/agent-mail/src/dial.ts`) calls it on every dial,
  then connects to the returned literal address — there is no second resolution
  to rebind — with TLS verified against the configured hostname, not the
  address.
  Raw sockets get the same policy through the same rules rather than a second
  copy of them: `resolveVettedAddresses` is the shared host check, and the
  IMAP/SMTP dialer (`packages/agent-mail/src/dial.ts`) calls it on every dial,
  then connects to the returned literal address — there is no second resolution
  to rebind — with TLS verified against the configured hostname, not the
  address.
  See `docs/security-audit-2026-06.md`.
- **The App Store (`/apps`).** One row is one app on `McpCatalogEntry`; the store
  reads a decision rather than re-deriving one, and connect orchestrates the
  existing OAuth/instance machinery.
  Read [`docs/standards/app-store.md`](docs/standards/app-store.md)
  before writing code here.
- **MCP connector management and external-agent products.** Catalog, instances,
  probe, projection, credentials, secret store, library, discovery and OAuth
  live in `@nessie/mcp-manage` and are never forked.
  Read [`docs/standards/mcp-connectors.md`](docs/standards/mcp-connectors.md)
  before writing code here.
- **DeepWater — default OFF, explicit per-agent grant, always via Ledger.**
  Enabling DeepWater provisions a team-scoped tool-projecting instance routed
  through Ledger; the handoff, grant bundle and ambiguity rules are exacting.
  Read [`docs/standards/deepwater.md`](docs/standards/deepwater.md)
  before writing code here.
- **Customer billing stays in UOA.** Tariffs, statements, credits, top-ups,
  subscriptions and Stripe lifecycle are authoritative in UOA; Nessie renders
  UOA-authored display models and stores no commercial state.
  Read [`docs/standards/customer-billing.md`](docs/standards/customer-billing.md)
  before writing code here.
- Builtin `web_search` is a Ledger-only Serper route. Ordinary agent, delegated
  sub-agent, and workflow calls all post to
  `${LEDGER_PUBLIC_URL}/v1/serper/search` with Nessie's product-bound
  `LEDGER_PROXY_TOKEN`, a fresh signed `X-Nessie-Context`, optional linked-user
  `X-UOA-Delegation`, and a stable tool-call id. The context must contain exact
  user/org/team/agent/run provenance; workflow queue identity is checked
  against its durable actor and installation scope before signing. Direct
  `google.serper.dev` calls and `SERPER_API_KEY` fallbacks are forbidden.
  Nessie's local connector rows are operational telemetry only; Ledger is the
  raw usage/cost source and UOA is the sole commercial authority.
- deep.agent crawl web scanning is an MCP connector template: install a Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, then approve/grant the discovered tools. The crawl library implementation belongs behind the deep.agent service boundary; do not embed Crawl4AI's Python package in the API/worker or expose an unauthenticated crawler to the public internet.
- **Individual Communications Connector.** Per-user OAuth connections normalise
  into a CommsEvent store through @nessie/comms-connect; the connector layer
  carries no reasoning logic.
  Read [`docs/standards/comms-connector.md`](docs/standards/comms-connector.md)
  before writing code here.
- **Google scopes, capabilities and send approvals.** A provider scope is a
  capability in one catalog and every check on it fails closed; an approval
  over provider content binds the content, not its handle.
  Read [`docs/standards/google-workspace.md`](docs/standards/google-workspace.md)
  before writing code here.
## Personal model subscriptions

A person links a consumer AI plan they already pay for and the agents **they
own** run on it instead of the organisation's Ledger credits. The lane is
pinned at run admission and never falls back to Ledger, token values live in a
dedicated vault project, and organisation budgets deliberately do not gate it.
Codex and Grok link through Nessie's own server-side device-code sign-in —
never an import of a vendor CLI's grant — and a first link is confirmed
against the account that actually signed in.
Read [`docs/standards/personal-model-subscriptions.md`](docs/standards/personal-model-subscriptions.md)
before writing code here.

## Embeddings — routed separately, one pinned width

- Embeddings are configured independently of chat via `NESSIE_EMBEDDING_*` (`PROVIDER`, `MODEL`, `SERVICE_ID`, `BASE_URL`, `API_KEY`); every unset field inherits the chat provider, so an unconfigured deployment is byte-identical to before. The chat provider may serve no embeddings endpoint at all — Ledger's DeepSeek adapter answers `403 embeddings is not allowed for deepseek` — so production embeds through `/v1/jina` while chat stays on `/v1/deepseek`. Resolution lives in `packages/runtime/src/inference/embedding-provider.ts` and is applied once in `createModelClient`; do not fetch embeddings through any other path. Signed `X-Nessie-Context` / `X-UOA-Delegation` identity travels with the embedding leg only while it stays on the chat host, so a third-party embedding endpoint an operator names never receives a delegation assertion.
- **`EMBEDDING_DIMENSIONS` (`packages/schemas/src/embedding.ts`) is the single source of truth for the vector width** (currently 1024, `jina-embeddings-v3`'s native width). Never write the number anywhere else — not in a producer, a validator, a test fixture, or the mock-LLM harness. The three pgvector columns (`thoughts.embedding`, `thought_recalls.query_embedding`, `knowledge_page_chunks.embedding`) are declared at that width, and every embed request sends `dimensions` so a provider answering differently fails loudly. Changing the embedding model to another width = edit the constant + one Prisma migration re-typing the columns + re-embedding; vectors of different widths are not convertible, so the migration nulls them rather than truncating (a truncated vector is neither model's output and poisons later comparisons).
- The model that produced a vector is `ModelClient.embeddingModel`, resolved from deployment config — not a constant. It is what gets written to `embedding_model` and what keys the query-embedding cache, so the two sides of a similarity comparison agree by construction rather than by two constants happening to match.
- a width-change migration drops the HNSW index, nulls the vectors, `ALTER COLUMN`s, and recreates the index (see `20260811120000_embeddings_1024_dimensions`); the `match_thoughts_*` functions need no change — PostgreSQL discards the typmod on function parameters.
- Spec: `docs/deployment.md` "Embedding model and vector width".

## File storage & accounting — single chokepoint

- **All blob file operations** — store, stream, download, delete, version, attachment-linking — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`.
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- JPEG/PNG/WebP uploads have EXIF/GPS metadata stripped at the `FileService` store chokepoint (EXIF orientation applied to the pixels first, ICC profiles preserved, accounting records the post-strip size); orgs opt out via `Organization.stripImageMetadata`, and images over 50 MiB or undecodable pass through unchanged to keep uploads streaming.
- **A previewable upload also owns a thumbnail** (`<storageKey>.thumb.webp`), derived at the same chokepoint: inline for raster images, via the `attachment.thumbnail` worker job for PDFs (first page, `@hyzyla/pdfium` — pure WASM, no native deps; AGPL/GPL renderers are disqualified), animated/exotic images, oversized images, and strip opt-outs. It is quota-gated with the original, carries its own `store.thumbnail` / `delete.thumbnail` usage events, and is freed by `FileService.delete` — the single place attachment bytes are removed, so nothing can leak it. Generation failures are never fatal (`thumbnailStatus = unavailable`, clients fall back to the original); existing attachments are not backfilled. Attachment downloads and thumbnails are served with `private, max-age=1y, immutable` + a strong `ETag`, with `If-None-Match` answered as a 304, because attachment bytes are immutable. Spec: `docs/plans/2026-08-06-attachment-thumbnails-and-previews.md`.
- **A run's context window carries its messages' attachments.** Every turn gets an inventory line appended at render time (kept beside `Message.content`, never inside it, so the prompt builder's raw-content comparison still matches), and `user` turns carry inlined image bytes on `ProviderMessage.images`. Bytes come from the same `FileService` chokepoint — original for a PNG/JPEG/WebP/GIF ≤ 4 MiB, else the stored `.thumb.webp`, else nothing — capped at 6 images per prompt (newest first), non-fatal on failure, and estimated for the context window. Whether they reach the wire is the connector's call, gated on its own truthful `supportsVision` (`openai`/`openai-compatible` yes; `deepseek`/`kimi` no, keeping the inventory line). The engagement orchestrator reads the same line so an image-only post can start a run; the judgement itself stays model-made. Logic lives in `worker/src/run/message-attachments.ts` — do not fetch attachment bytes for prompts anywhere else. Spec: `docs/plans/2026-08-07-images-in-agent-context.md`.
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See `docs/deployment.md`.
- Thumbnails, images in agent context, and the storage backends in full:
  [`docs/standards/file-storage.md`](docs/standards/file-storage.md).


## Agent documents — one shared home provisioner


Knowledge-space provisioning lives in `@nessie/knowledge`:
`packages/knowledge/src/provisioning.ts` owns `ensureMyDocsSpace`,
`ensureProjectDocumentsSpace`, `ensureTaskFolder`, and the advisory-locked
`ensureAgentDocsSpace`; `api/src/services/knowledge-provisioning.ts` is only a
thin re-export for established API callers. At inference-run setup, a
non-system agent with an assembled KB write tool lazily gets its private
`<Agent> — Documents` home (or reuses it); a spawned child uses its parent's
home, and the Personal Assistant has none because its documents belong in the
person's My Docs. When `kb_list`, `kb_search`, `kb_document_compose`, and
`kb_document_edit` are all actually available, the structural system-prompt
block injects that home id and title so the model never invents a `spaceId`.

## Cloud browsers — a second transport, not a second browser surface


Agents drive a real Chromium in the cloud (Browserbase) as well as the one the executor runs on a person's machine (phase 1 shipped 2026-09-02). The browser verbs are the executor's own closed grammar reused verbatim under their own `requiresExplicitGrant` key; connection scope follows the surface that accepted the key; and because browser-hours are money, release is fused to `updateRunStatus` while a reaper stops strays by calling Browserbase. Those invariants, their rationale and the as-built deltas (§5a) live in [docs/plans/2026-09-02-browserbase-cloud-browsers.md](docs/plans/2026-09-02-browserbase-cloud-browsers.md) — read it before touching this.

## Message reply threads (#233)


`Thread` is a conversation *container* (channel → named threads); Slack-style *reply threads* live one level deep on messages: `Message.rootMessageId` (nullable self-FK; replies to replies attach to the same root), with materialized per-root `replyCount`/`lastReplyAt`/`replyParticipantIds` updated atomically via `@nessie/runtime` `applyReplyBookkeeping` in the message-create transaction, and `MessageThreadFollow` per (user, root) with auto-follow on participate (author the root, reply, or be mentioned in a reply) plus explicit unfollow. Reply visibility inherits the container; deleted roots tombstone and keep their replies; "Also send to #channel" posts an inline top-level copy carrying `metadata.replyBroadcast.rootMessageId`. Message-create accepts `rootMessageId` (validated same-container top-level root); list defaults to top-level posts and takes `?rootMessageId=` for paginated replies; realtime adds `message.reply` + `message.reply.meta`. A run triggered by a message replies **into that message's reply thread** by default (root = `triggerMessage.rootMessageId ?? triggerMessage.id`), and thread-following scopes to that reply thread; DeepWater/product-handoff and external-agent paths stay top-level and byte-identical. **Where a run replies and what it reads are separate questions** (`resolveReplyRootMessageId` vs `resolveConversationRootMessageId`): the conversation window narrows to a reply thread only when the trigger message is *itself* a reply. A run answering a top-level message is starting a reply thread, not sitting in one, so it reads the channel thread — scoping it to its own trigger would leave it a one-message window with no history. Admin: reply-summary bar under roots and a deep-linkable right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`); how it presents per layout, and how it closes, is the navigation framework's call ([docs/navigation/overview.md](docs/navigation/overview.md) §7, "The reply thread panel on `split`"). Reply-unread counters (#212) and the Threads inbox (#213) build on `MessageThreadFollow`.

**Reply placement + thinking bubbles** ([docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md](docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md)): where a run's reply lands is decided **before** the run starts — engagement decisions carry a model-judged `replyPlacement` (`thread` = answer owed to the asker's exchange; `channel` = standalone message to the room; @mentions and PA DMs stamp `thread` structurally, never by content heuristics) persisted on `Run.replyPlacement`; `resolveReplyRootMessageId` (`worker/src/run/execute/reply-placement.ts`) applies it after the DeepWater-handoff/external-agent/PA-delegation carve-outs and persists the resolved anchor on `Run.replyRootMessageId`. While a run thinks, a per-run `ThinkingRecorder` coalesces visible reasoning deltas (2 KiB/250 ms) plus tool-activity lines into durable `run_thinking_chunks` rows, each also published on the thread SSE stream with its chunk id (`stream.reasoning` / `stream.thinking.tool`; `stream.start` now carries the reply anchor, and `stream.done` is always published last). The admin renders a dashed, full-width **thinking bubble** with a 1–2-line live thought ticker wherever the reply will land — bottom of the channel feed for top-level replies; compact under the root row plus full bubble in the thread panel for threaded ones (reply text streams only where the reply will land) — and clicking it opens a centered thought-process dialog that streams live and merges the durable log for mid-run joiners (`GET /api/threads/:id/thinking` bootstrap, `GET /api/threads/:id/runs/:runId/thinking` full log, both thread-visibility-gated; `stream.*` stays excluded from SSE backlog replay).

**Liveness (client only, no server events).** The thread SSE reconnect policy lives in `admin/src/facades/threads/stream-retry.ts`: only **403/404** end the loop (the viewer cannot see this thread); every other outcome — 401 mid token rotation, any 5xx, a bodyless 200, a network error — reconnects with equal-jitter exponential backoff (1 s base, 30 s cap) that resets on each established connection. It used to `break` on any non-OK response, which killed bubbles and streaming text for the rest of the component's mount while replies kept arriving over the WebSocket refetch path. Because `stream.start` only fires after queue pickup, the engagement-decision call, a second queue hop, run claim, toolset assembly and memory retrieval, the admin also shows one **anonymous ambient line** — three muted `.liveness-dots`, no name, no avatar (`liveness-hint.ts` + `useAgentLivenessHint.ts`, `ChannelMessageFeed` `showLivenessHint`) — from the moment the viewer posts into a surface that structurally has an agent (bound agent, PA DM, or external-agent DM). It never names an actor because the engagement decision is model-judged and may decline, and it clears on the first of: a pending stream entry for that surface (the bubble *is* the indicator, so the two are never painted together — visibility is derived during render, not cleared in an effect), a message from anyone but the viewer, an agent reaction (`acknowledge`), or 10 s. Idle renders nothing; the channel feed and the reply panel share the one hook and the one feed component.

Legacy single-user server lives in `src/` and is being removed — do not rely on it for new work.

## Web Push (browser notifications)


- Browser Web Push is a second push transport alongside native APNs/FCM: the worker's `handlePushDispatch` also fans messages out to users' `WebPushSubscription` rows. Crypto is in-process (`packages/push`, RFC 8291 + RFC 8292 VAPID, no third-party deps).
- One VAPID key pair per instance via `NESSIE_WEBPUSH_PUBLIC_KEY`, `NESSIE_WEBPUSH_PRIVATE_KEY`, `NESSIE_WEBPUSH_SUBJECT` (all three required to enable). Generate with `node scripts/generate-vapid-keys.mjs`. Public key is safe to expose; private key is secret.
- Admin SPA service worker (`admin/public/sw.js`) + manifest + a "Browser notifications" toggle on `/settings/notifications`; API endpoints under `/api/push/web/*`. Requires HTTPS (localhost exempt); iOS needs an installed PWA (16.4+).
- **Authoritative guide: [docs/web-push.md](docs/web-push.md).**
- User alerts: direct @mentions write durable per-recipient `UserAlert` rows in the message-create transaction (self skipped, broadcast none, agent-authored identical; mute suppresses push, never the row) and surface via `GET /api/alerts` + `POST /api/alerts/read`, realtime `alert.created`/`alert.read`, the admin top-bar bell, and mention-framed push (`<author> mentioned you in <channel>`). `workspace_invitation` alerts are reconciled from every verified UOA `/org/me` read, follow the user's current local organisation for bell visibility, and are deleted—not read-marked—when UOA no longer returns the invite or acceptance succeeds.

## Provider-linked calls + ringing


Calls are provider links, never an embedded Jitsi media surface: an owner or
admin selects each target team's Google Meet, Jitsi, or (when configured)
Microsoft Teams provider in `/settings/organization`; the caller popup links
its provider label there for that same audience. A channel call creates that
link then rings each invitee. Realtime publishes one
message per audience — one channel update and separate user-scoped incoming
rings — because combined scopes leak/replay incorrectly. Native push carries
only an internal call path/id, never an external meeting URI; the client loads
the call before opening the provider link. Browser Accept is a real anchor (or
a synchronous user gesture in a shell), never an asynchronous `window.open`.
`meeting_link_create` and `call_start` are PA-only builtins: they re-read the
acting member and call the same `@nessie/workspace-admin` functions as the
routes; `call_start` resolves membership from its target channel's organisation
and stamps `Call.createdViaAgentId`.

## Docs


- [brief.md](docs/brief.md) — Historical architecture brief (see banner)
- [build-ai-coworker.md](docs/done/build-ai-coworker.md) — Historical macOS app build plan (moved to done/)
- [context-window-optimization-audit.md](docs/context-window-optimization-audit.md) — Audit + prioritized roadmap for LLM context-window usage in the agentic run pipeline
- [known-limitations.md](docs/known-limitations.md) — Code-verified register of current limitations (status taxonomy; two fixes in flight as of 2026-07-23)
- Finished documents belong in `docs/done/`.
