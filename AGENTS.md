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

- Worktrees are mandatory. The main project checkout always stays on `main`; never edit it directly. Every task — and every parallel agent/CLI — works in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never reset, clean, or discard another worktree's or agent's work. When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked. After merge, remove the worktree and delete the merged branch.
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

- All standards, specs, and design decisions live in `docs/`.
- When a document is finished, move it to `docs/done/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the architecture guardrails and anti-pattern list in `docs/architecture.md` before creating files, reorganizing code, or reusing logic.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
- **UOA owns the org structure, not just the people in it.** Where UOA SSO is
  configured, its organisation and team hierarchy maps **1:1** into Nessie: one
  UOA organisation is one Nessie `Organization`, bound by the stable UOA
  organisation id (`Organization.externalOrgId`, unique), and one UOA workspace
  is one `Team` (with its Project and `#general`) inside that organisation.
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
- **A personal-assistant tool that does what a person does by clicking calls
  the same function that person's button calls, and mirrors that route's
  authorization exactly — no weaker, no stronger.** The provisioning builtins in
  `worker/src/run/pa-tools/provisioning.ts` are the pattern: `agent_list` and
  `channel_create` are member-level because their routes carry only
  `requireActorContext`; binding reproduces all four gates of
  `POST /api/agents/:agentId/bindings` (channel membership, the system-channel
  refusal, owner, `checkPolicy('agent','bind')`); trigger creation parses the
  route's own `CreateAgentTriggerBodySchema` and refuses a schedule with no UOA
  identity on a signing deployment. Because `api/src/services/*` is unreachable
  from the worker, the shared functions live in **`@nessie/workspace-admin`**
  and the api services re-export them — never a second copy in `pa-tools`.
  `pa-tools/channels.ts` carried a "mirrored from api/src/services" comment over
  a duplicated `canManageChannel` for exactly that reason; on 2026-08-29 the
  predicate and the writes it gates moved to `channel-manage.ts`, which the api
  service re-exports and the PA tool imports. An owner-gated tool stays visible
  to non-owners and refuses in words, following `pa-tools/connectors.ts`. Role
  comes from the live `OrganizationMember` row at call time, not from the run's
  enqueue-time `actorContext`. **A tool that takes an id ships with the read
  that resolves it**: in the UI the owner picks the agent from a list, so
  `agent_list` (→ `listAgentsForUser`, `GET /api/agents`'s own entitlement
  scoping) is what makes `agent_bind_channel` / `agent_trigger_create` usable on
  an agent the user merely named. Details: `CLAUDE.md` → "Personal assistant —
  workspace provisioning".
- **A global agent is a blueprint in code, one row per organisation, and a
  single-agent DM.** App-provided agents (the Agent Designer is the first) live
  in a registry in `@nessie/workspace-admin`; `ensureGlobalAgent` instantiates
  each as one `systemManaged` row per organisation, keyed by `Agent.systemSlug` —
  unique on `(organizationId, systemSlug)` with a CHECK requiring `systemManaged`
  AND a non-null `organizationId`, so a cross-org vendor row is a database
  impossibility and a display name is never again the discriminator. The ensure function is
  `ensurePersonalAssistantAgent` verbatim in shape, with tool policy merged
  under `acquireAgentToolPolicyLock` *after re-reading the row* so a targeted
  grant committed in between survives, and the blueprint's own policy passes
  `assertGenericAgentToolPolicyInput` like user input: vendor config is not
  authority. Its home is a per-user private DM keyed
  `gagent:{slug}:{orgId}:{userId}`, admitted by the channel-surface CHECK under
  its own `system_agent` type (never a widened pattern — the `extagent:` lesson)
  and held to exactly its encoded member (owner at **segment 4**) by the deferred
  home-membership trigger. Sole membership is what makes `effectiveUserId =
  poster` and the single-candidate fast path safe, so it must hold at rest. Three
  refusals keep it true: no agent binds into ANY system channel
  (`bindAgentToChannel`, both routes, the PA tool; `canManageChannel` likewise
  refuses rename, archive and re-membering), `createAgentTrigger` refuses a
  `systemSlug` target (a scheduled run re-arms its creator's identity), and
  `assertGlobalAgentRunPlacement` admits only the home DM before any inference. Reachability is the point of the tier: `listAgentsForUser`'s
  `includeSystemManaged` arm is `{ organizationId, systemManaged: true }` and no
  longer channel-gated: an app-provided agent nobody can find is the
  unreachable-capability defect Rule zero names. Finding one has to lead
  somewhere, so it renders **the ordinary detail surface with every control
  disabled** — the same designer form, filtered to Edit + Tools — never a second
  read-only view beside it, while `isAgentAccessibleToActor` stays untouched:
  status, activity, messages and children still 404, a global agent's activity
  spanning every member's private DM. `docs/global-agents.md`; spec:
  `docs/plans/2026-09-02-agent-designer-global-agent.md`.
- **A capability can be moved to a specialist without being deleted.**
  `BuiltinToolDefinition.identityDelegatedOnly` narrows `personalAssistantOnly`
  to the identity-delegated arm alone — `agent_create`, `agent_read`,
  `agent_update`, `agent_tool_catalog`, `agent_avatar_update` are reachable only
  by a blueprint that declares them, in its own home DM, on an interactive human
  turn. Not even a Personal Assistant: it keeps the operational verbs on existing
  agents and hands over with `agent_handoff`, the design catalogue being large
  and belonging in one agent's context. A flag that removes an arm — the tool
  *omitted* from the PA's schema, not offered and denied — is the honest
  mechanism; deleting it would take it from the specialist too.
- **"This run delegates to its requesting person" is ONE predicate, and the
  identity-tool gate widens by exactly one arm.** The worker keyed delegation on
  `agentKind === 'personal_assistant'` in five places — memory scopes, realtime
  narrowing, reply attribution, the trigger binding waiver, the acting-member
  helpers — because the PA was the only delegate. A global agent is
  `agentKind: 'shared'` and delegates as completely, so all five would have
  treated it as ordinary with no failing check anywhere.
  `runDelegatesToRequestingPerson` (`worker/src/run/delegated-identity.ts`) is
  the one answer: the PA in its own DM, or a `home: 'per_user_dm'` blueprint in
  its own home DM, derived from agent kind + `systemSlug` → blueprint + the
  destination's `systemChannelType`/`dmKey`, never content. Both arms are
  surface-keyed — a PA presence in a shared room still carries its owner's
  identity, so the exemptions key on the surface, never the kind. Memory
  containment and realtime narrowing moved onto it; reply re-attribution and both
  *binding* waivers stay PA-only. `personalAssistantOnly` gains one arm beside the PA's: the blueprint's `identityToolIds` lists that id, the run is on
  the agent's own home DM, and `payload.interactive === true` with a live human
  requester whose id equals the stamped `effectiveUserId` — resolved **once** at
  run setup and passed to BOTH `resolveAgentTools` (the schema omits them, never
  offer-then-deny) and `authorizeToolCall` (a stale schema cannot be exercised),
  never to a delegate sub-agent. That interactive arm is the second of two locks
  with the `createAgentTrigger` refusal: remove either and an unattended run
  reconstructing an absent creator's `effectiveUserId` creates agents and
  channels as that person. Delegated reads it opens feed the disclosure sink.
- **Every path that starts a run in a single-member delegated system DM stamps that member as `effectiveUserId`, or the run silently loses its identity tools.** The gate above requires `effectiveUserId === actorId`, and an unstamped run does not fail: it resolves no requester, the tools are absent from the model's function set, and the agent truthfully reports it cannot create anything. The stamp lived inline in `thread-message-create.ts` and was missing from the agent-card press, so a *typed* message worked while a button press did not — in the one agent whose whole style is card-driven. `isDelegatedSystemDmChannelType` and `withDelegatedSystemDmIdentity` are now ONE definition in `@nessie/schemas` (the predicate had existed twice, once per process, each copy warning that the other must not drift), and `enqueueOrchestrateDecide` resolves the destination channel itself and applies it, so every human-turn wake path is correct without its author knowing this rule exists; a caller-supplied `systemChannelType` is exactly the argument a new path forgets. `enqueueRunExecution` gets no such chokepoint — its callers build actor contexts from six provenances and a blanket stamp would guess whose identity is in play — so each call site is classified `stamps`/`inherits`/`unattended` in `api/test/delegated-system-dm-enqueue-sites.test.ts`, which fails until a new one records a verdict. A resumed run is the case worth naming: a `wait: true` card parks its run and the press resumes from the *parked* run's actor context, so `run-resume-core.ts` re-asserts the destination's rule rather than trusting what it inherited. `docs/global-agents.md`.
- **`agent_handoff` passes the person, and its bounds are structural.** Any
  agent may hand a conversation to a global agent: a hidden server-authored
  `system` brief — the trigger-kickoff mechanism, never the integration
  handoff's `role:'user'` message rendering model text as the person's own
  editable words — into the *requesting person's* home DM, plus one doorway
  message in the origin room. The requester is the **actor**, never
  `effectiveUserId` (a PA presence carries its owner's while another member
  asks); with `interactive === true` and a live membership re-read, that also
  refuses every unattended, trigger, subtask and agent-authored run. Bounds are
  **withheld, not asserted**: the tool is omitted from any `systemSlug` agent's
  schema and from `spawn_subtask` children in `authorizeToolCall`, and one
  cooldown row per `(requester, slug)` converges retries and continuations onto
  the one briefing. The brief's basis subtracts **every scope the requester
  satisfies**, or the DM's only member cannot read its own specialist. Delivery
  is the one shared `deliverGlobalAgentBrief`, which claims the slot with
  `claimThreadRunOrPend`. `docs/global-agents.md`.
- **Provider-linked call tools use this same route-mirroring pattern.**
  `meeting_link_create` and `call_start` are separate PA-only builtin ids:
  minting a provider link and ringing a channel have different blast radii, and
  only separate ids can later put `call_start` behind an explicit grant. They
  intentionally require no explicit grant today because a person's PA is their
  delegate. Both re-read the live acting membership and call
  `createCallLinkForTeamUser` / `startCallForUser` in
  `@nessie/workspace-admin`; never duplicate their gates. A call tool leaves
  `expectedOrganizationId` unset so the shared start seam resolves the
  **target channel's** organisation and re-checks membership there, preserving
  the route's indistinguishable `Channel not found` refusal across UOA orgs.
  An unattended run has no requesting user and must refuse before minting.
- **A read that enters a run's context feeds the disclosure sink, in the same
  change.** An agent reaches material its audience cannot, and what stops it
  laundering that into a shared room is provenance: `ConsumedSourceSink`
  (`worker/src/run/execute/disclosure-basis.ts`) collects the scoped sources a run
  consumed, `computeReplyBasis` subtracts what the destination already implies,
  and the remainder is stamped on the message and the run by the one write
  chokepoint (`agent-message.ts`). **An empty basis means unrestricted**, so a
  read path that forgets to feed the sink does not fail loudly — it publishes to
  everyone. That is the whole defect class, and it is why the obligation sits on
  the *read*, not on the reply. Adding a tool that puts content in the window and
  not adding its scope is the same defect as skipping the `FileService`.
  Corollaries, each learned from a real gap: resolve a source's scope with the
  shared `scopeForVisibility` rather than a second mapping beside your reader,
  since a thought's `(audience_type, audience_id)` and a knowledge space's
  `visibility` + chain are one fact in two shapes; record a channel scope only
  when the channel is **not public**, because viewer channel scopes come from
  `ChannelMember` rows alone and stamping a public channel withholds the reply
  from people entitled to read the source; and make search **fail closed**
  (exclude anything carrying a basis) rather than withhold, because a snippet
  list has nowhere to render a placeholder. On the read side every path asks the
  one predicate — list, single message, and the durable thought log alike, since
  reasoning inherits the provenance of what the reply was built from. The live
  SSE lanes cannot filter per viewer, so they are cut structurally by
  `runReplyIsRestricted` the moment a run consumes a privileged source; that
  predicate is monotone by construction, which is what makes it safe to call per
  delta. Containment (`constrainScopesToDestination`) is a floor under all of
  this, but it constrains **memory recall only** — never treat it as "nothing
  crosses". Details: `CLAUDE.md` → "Disclosure boundaries"; spec and build status:
  `docs/plans/2026-08-11-disclosure-boundaries-build.md`.
- **An agent belongs to a person, and the org tree is a read-time JOIN — never
  a stored hierarchy.** `Agent.ownerUserId` (stewardship: their "virtual
  employee") is the only local fact behind it; people, roles, teams and
  lifecycle come from UOA live on every read. There is deliberately **no human
  reporting edge**: UOA's roster carries no manager field, and an edge that
  decided authority would be the second org hierarchy the SSO invariant forbids
  whatever table it sat in. Tenancy is enforced in the database — a composite FK
  `(organization_id, owner_user_id) → organization_members`, because
  `spawn_subtask` writes agents outside the `createAgentRecord` chokepoint, with
  `ON DELETE NO ACTION` since on a composite key `SET NULL` blanks *every*
  referencing column including `organization_id`; a CHECK keeps ownership off
  system-managed and org-less agents (the PA is one org-singleton row serving
  everyone). The FK proves the membership row *exists*, never that it is live:
  deactivated rows are retained deliberately, so **every read re-derives
  `deactivatedAt: null`**. One predicate, `buildVisibleAgentWhere`, is shared by
  `listAgentsForUser`, `isAgentVisibleToUser`, and every access rule that derives
  a human audience from an agent, so list, detail, and derived access cannot
  disagree. Its stewardship arm's conditions are load-bearing — the live-membership
  join (the branch widens by pointer equality, so without it a deactivated
  member keeps seeing their agents) and `parentAgentId: null` (else owning one
  agent pours every unreaped `spawn_subtask` child into that list forever).
  `Agent.visibility = private` is the deliberate exception to org-owner
  omniscience: every entitled agent read composes `buildAgentVisibilityWhere`,
  and only the private agent's live owner passes its private arm — an org owner
  never sees another person's private agent. Subtask children inherit both
  owner and visibility so delegated private work cannot mint workspace-visible
  rows. A private agent is created atomically with its exact owner-only
  `agent:{org}:{owner}:{agent}` home DM, and the worker refuses any run outside
  that home or the agent's own trigger thread before inference. Deactivating its
  owner pauses only its triggers and records one aggregate audit transition;
  the owner-only Members surface receives the count through
  `GET /api/agents/paused-private-count` and never private rows or names;
  workspace agents keep running, no private detail is widened, and reactivation
  never resumes automation implicitly.
  `loadAgentChildren` takes the viewer's scope for the same reason. Never
  backfill ownership: nothing recorded who created an agent, so old rows read
  `Unowned` and `agent.created`/`agent.owner_changed` now emit instead. The tree
  itself is one `buildPeopleAgentsTree` rendered on `/settings/members` with the
  people source parameterised (UOA roster, or local `User` rows on a no-IdP
  install) — *unowned* and *owned outside this workspace* stay separate buckets,
  because the roster is team-keyed and a colleague on another team is otherwise
  indistinguishable from someone who left. `resolveLocalUserIdsByUoaSub` is
  org-scoped: `User.uoaSub` is globally unique, so the naive lookup hands this
  organisation a principal id for a stranger. Spec:
  `docs/plans/2026-08-29-people-and-their-agents.md`.
- **Ownership decides who may edit, and "edit" is field-sensitive.** Every
  agent-mutation route gated on the ORGANISATION owner role, so no ordinary
  member could edit any agent — not even the private one they own. It never
  surfaced because the people editing were org owners. `canEditAgent` /
  `assertAgentFieldAuthority` (`@nessie/workspace-admin`
  `agent-edit-authority.ts`) replace `requireOwner` at `PUT /api/agents/:id` and
  both avatar routes, and are the one rule chat tools consume too, so routes and
  the Agent Designer cannot disagree. A **private** agent is its live owner's
  alone (an org owner cannot see it, so cannot edit it); a **person-owned**
  workspace agent takes its live owner plus org owners (without that override a
  deactivated steward leaves an agent with no editor); a **team-owned** agent —
  `ownerUserId` null — takes anyone entitled to it, plus org owners; a
  `systemManaged` agent takes nobody, refused **in the service**
  (`SYSTEM_AGENT_IMMUTABLE`) rather than only hidden by route invisibility.
  Owner-ness is re-derived from the live `OrganizationMember` row on every call,
  never the session claim or an enqueue-time snapshot. A null owner is a
  **deliberate state**, not missing history: "team-owned" means any member who
  can see the agent may rewrite its prompt, model, tools and limits, while
  *placement* (`agent_bind_channel`) keeps its stricter four gates — editing
  improves the shared agent in place, binding changes who is exposed to it. One
  predicate over the whole PUT body would be wrong, because that body also
  carries `ownerUserId` and `todosEnabled`: ownership transitions belong to the
  current owner or an org owner (so *claiming* a team-owned agent is
  org-owner-only by construction) and `todosEnabled` keeps its own org-owner
  gate — both firing only on an actual change, so a form echoing the stored
  value back stays an ordinary edit. Unchanged by all of it:
  protected/explicit-grant policy keys (`assertGenericAgentToolPolicyInput` is
  the law for every editor), immutable `visibility`,
  `AGENT_PRIVATE_TRANSFER_UNSUPPORTED`, and the `agent.owner_changed` audit on
  both transfer and release. Details:
  `docs/plans/2026-08-29-people-and-their-agents.md`; decision:
  `docs/plans/2026-09-02-agent-designer-global-agent.md` → "Edit authority".
- **An interactive card is one system, and its press is claimed once.** Every
  agent that can talk can post a card (`card_post`, default-on) whose buttons a
  person presses; `AgentCard` is the authority and the message carries only its
  id, because a press must be claimed by a conditional UPDATE carrying the
  decision (`status = 'open'`) rather than a JSON mutation, and whether a given
  viewer may press is a per-viewer server decision. The body is a **closed block
  vocabulary** (`text`, `fields`, `image`, `link`, `input`, `secret`) plus up to
  four actions, so a ticket, an email overview and a form share one renderer — a
  `kind` per integration is the eighth look-alike Rule zero names, and the seven
  existing metadata cards are exactly why. The press writes a real `user`
  message stamped `agentCardResponse`, which is what puts the outcome in the
  chat, in the agent's transcript, and on one *structural* orchestrator path
  that wakes the card's agent (a server-written key, never content matching); a
  resolved card additionally renders its live state beside its message content
  in every later window, so nothing rewrites a message. Waiting on a card
  (`wait: true`) reuses the approval suspend/resume machinery through one shared
  core each — never a second copy of the claim-once discipline — and parks the
  run in `waiting_input`, non-terminal and holding the thread slot. A `secret`
  block's value goes through the same `storeInstanceSecret` seam and the same
  authorization as the instance-secret route, inside the press transaction, and
  is absent from the row, the message, the audit metadata, the realtime payload,
  the presenter and the model: only that it was provided, and where. Details:
  `CLAUDE.md` → "Agent chat cards"; spec:
  `docs/plans/2026-09-01-agent-chat-cards.md`.
- **Live document streaming taps the model's own tool-call arguments, and its
  live path never touches durable storage.** `kb_document_compose` emits the
  document as its `markdown` argument; the enriched `tool_call.delta` events
  feed a per-run recorder whose *live* lane publishes each provider chunk over
  `publishSseEphemeral` (notify-only) and whose *durable* lane coalesces
  separately for bootstrap — two lanes precisely so a slow INSERT cannot delay
  a token. The drain loop calls the recorder synchronously; anything that would
  make the provider read wait belongs on a lane, not in the callback. Session
  identity is `(runId, invocationId, toolCallId)` because indexes restart per
  attempt and retries re-issue the same iteration. Never publish a document
  delta durably, never emit a partial escape or lone surrogate to a client
  (`createPartialJsonScanner` owns that invariant), and never save a document
  the streamed text does not byte-match. Interruption of any kind saves
  nothing. **Editing an existing document is deltas, never a rewrite**
  (`kb_document_edit`): `{find, replace}` pairs anchored to an exact single
  match, streamed in document order, with the edit site published *before* its
  replacement text so a viewer can move there and wait. The streaming preview
  (`document-stream-edit.ts` tracker) and the save (`applyDocumentEdits`) are
  deliberately independent implementations and the save asserts they agree —
  never collapse them into one, or the check becomes a restatement. An
  ambiguous anchor is skipped in the preview and refused in words at save.
  Spec: `docs/plans/2026-08-13-live-document-streaming/overview.md`.
- **A capability that can stop working owns the way a person finds out.** A
  recurring trigger whose captured UOA identity stopped verifying was flipped to
  `error` and abandoned — non-claimable by the sweep, abandoned by the retry
  poller, and announced to nobody, so one production schedule was dead and
  silent for nineteen days. The obligation sits on the **transition**, not on
  whoever might later look: classify the failure into a state that names its
  remedy (`needs_reauthorization` is a button; `error` is an edit), persist the
  reason so the surface can explain it, and alert exactly once per transition —
  `health_revision` plus the existing `user_alerts (user_id, event_key)`
  uniqueness, never a second marker table. Exactly-once is what separates this
  from the repeating-apology failure the unattended-run path deliberately avoids
  (`worker/src/run/execute/failure.ts`): an unattended run posts nothing to chat
  for good reason, so the signal has to be a durable alert instead. Recovery is
  **explicit** — `POST /api/triggers/:id/reauthorize` re-captures a live
  identity, sharing `captureScheduledLaunchOrigin` with the create route. Never
  auto-heal at login: signing in proves the same person is present, not that
  they intend a dormant automation to resume, and an epoch may have rotated
  because access was withdrawn. Re-stamp the **epoch only**; the organisation
  and team decide billing attribution, so refreshing them from whoever clicks
  repair moves a schedule's costs as a side effect. Re-arm from **now**, or a
  long-dead cron schedule grinds through every missed occurrence. And a fire
  gate must ask exactly what dispatch asks: checking a strict subset let
  triggers pass, create runs, and die at the first inference invisibly. Details:
  `CLAUDE.md` → "A schedule that stops says so".
- **A tool declares where it belongs; no surface guesses.**
  `BuiltinToolDefinition.category` is **required** and its vocabulary is
  `TOOL_CATEGORIES` in `@nessie/schemas` — one ordered list of
  `{id, label, description}` that every surface listing tools renders in order.
  The admin used to infer a category from the tool's id prefix (`file_`,
  `web_`, `kb_`…) and sweep everything unmatched into one "Agent & workspace"
  bucket; that bucket had grown to hold **75 of 116** builtins, because a new
  tool joined it by default and the only way out was to invent another prefix
  rule. Making the field required means adding a tool without choosing a home
  does not compile, and `packages/runtime/test/builtin-tool-categories.test.ts`
  additionally refuses any category holding more than a quarter of the
  catalogue — crossing that means the category has stopped describing anything
  and needs splitting, not that the ceiling needs raising. A category is a
  place a person would go looking ("where do I turn off email?"), never an
  implementation detail. The category is resolved onto `ToolDescriptor` from
  the definitions at the API boundary, beside `requiresExplicitGrant` and for
  the same reason — it is a property of the tool's code, so re-categorising one
  must never need a migration. The picker renders **every section closed**: 116
  tools across sixteen categories is an index, not a page of switches, and
  searching expands only the sections that still match without disturbing the
  ones a person opened. One component draws that list in both modes
  (`ToolPicker`, `readOnly` for a viewer who cannot change a tool); the
  separate read-only renderer that used to exist had drifted to its own
  grouping, its own cards and no search at all.
- **An agent's mailbox is its own store, and everything about it is
  structural.** Hosted agent email (`support@nessie.works`, Amazon SES
  integrated directly, off unless four `NESSIE_EMAIL_*` variables are set) keeps
  mail in `email_messages` rather than `Message` rows, with one backing
  `agent_email` channel per mailbox and one thread per conversation as the
  operations room. Four invariants carry it, each closing a fail-open: inbound
  **routes on the SES receipt envelope**, never the sender-written MIME headers,
  which omit Bcc and can name another tenant; delivery is **claimed once on the
  receipt id in the same transaction that wakes the run**, so an SNS retry
  cannot double-send or double-spend, while the forgeable `Message-ID` stays a
  threading index that degrades to a new conversation; **waking is a header
  fact** (`bulk`/`dsn`, failed spam/virus/auth verdicts store without spending a
  run) and never a keyword list; and **sending is gated structurally in
  `email-send-gate.ts` through `forceApproval`**, not in `PolicyRule` rows,
  because `evaluateToolInvokePolicy` defaults to allow and seeds no send rule —
  a policy-only gate would be absent wherever nobody configured one. That gate
  additionally forces an approval, naming the sources, whenever a run consumed
  anything beyond its own mailbox and thread; `email:{mailboxId}` is the scope
  that makes "answered from this correspondence" distinguishable, and it must
  stay implied by the mailbox's own thread or every reply deadlocks (four tests
  pin this). A send is `queued` → conditional `sending` → `sent`, with an
  ambiguous outcome parked at `delivery_unknown` and **never retried** — a retry
  is a duplicate in someone's inbox, and a sweep resolves a claim whose worker
  died so it cannot sit in `sending` forever. That claim stops one ROW being
  sent twice; what stops two ROWS existing is `EmailMessage.sendKey`, the tool
  call's own `{runId}:{toolCallId}`, because a replayed run re-issues the same
  call. Suppression and the hourly cap are enforced **inside** the queueing
  write rather than beside it — a check a caller must remember is a check a
  caller can forget, and counting outside the transaction let two concurrent
  runs both pass the last slot. An email attachment asks the same
  agent-visibility question the mailbox reads ask, so the byte surface and the
  conversation surface close together. Deleting a mailbox retires its address
  permanently. Details: `CLAUDE.md` → "Agent email"; plan:
  `docs/plans/2026-09-02-agent-email.md`; AWS setup: `docs/deployment.md`.
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
  See `docs/security-audit-2026-06.md`.
- **The App Store (`/apps`) is the product surface on `McpCatalogEntry`, never
  a second catalogue.** One row is one app; a parallel `mcp_apps` table would
  guarantee drift. Store visibility is
  `moderationState IN ('curated','approved')` + `trustLevel <> 'blocked'`
  composed with `catalogTenancyWhere` — and `curated` additionally requires
  public+published or caller-owned, because the migration backfills `curated`
  onto every pre-existing non-public row and a bare `IN` would list one
  member's private draft connector to their whole organisation. **The store
  reads a decision and never re-derives one from `status`**: approval writes
  `approved`, rejection and deprecation write `hidden`, and submission writes
  nothing (a request is not a decision). Skipping those writes is what let a
  rejected connector keep rendering to its owner and a deprecated one keep an
  enabled Connect button. Ranking lives
  in Postgres (weighted name/aliases A, publisher B, tags C, prose D, plus a
  `pg_trgm` typo fallback); **the client filters nothing and re-sorts nothing**,
  because re-scoring the server's answer in the browser silently drops the
  fuzzy matches only the index can find. `search_vector` is trigger-maintained
  rather than a generated column — `array_to_string` is only STABLE and
  Postgres refuses it (`42P17`). Every `/api/apps` response goes through a
  presenter that cannot emit a `credentialRef`, auth/transport config, endpoint
  URL, or a raw upstream icon URL, and `listAgentsWithAppAccess` imports
  `buildAccessibleChannelWhere` from `@nessie/workspace-admin` rather than
  restating it, so a member-readable surface can never name an agent
  `GET /api/agents` would withhold. Spec:
  `docs/plans/2026-08-29-apps-catalogue/overview.md`.
- **App Store connect orchestrates the existing OAuth/instance machinery; it is
  never a second stack.** `POST /api/apps/:slug/connect` sequences
  `createInstance` → probe → `startOAuth`. PKCE must be present on BOTH legs —
  sending `code_challenge` without returning `code_verifier` makes any RFC 7636
  §4.6 server reject the exchange, and the completion tests that used an
  argument-ignoring stub are why that shipped unnoticed once. The OAuth callback
  stays a **constant HTML page that never redirects** (a caller-supplied return
  URL is an open redirect); it posts a fixed message to its opener at a
  server-resolved origin, and the popup carries `noopener` because its first
  navigation is the third-party authorize URL, not ours. **Installing an app is
  not granting it**: `McpServerInstance.requiresExplicitToolGrant` (default
  false) is carried into `projectMcpToolDescriptors` on both the create and
  update branches — update too, or a capability discovered by a later refresh
  projects open and silently widens the app — and the worker's existing
  `isExposed` enforces default-OFF. Never add a grant table: `ToolGrant` rows
  exist and the worker never reads them.
- MCP connector management logic (catalog, instances, probe, projection,
  credentials, secret store, library, discovery, OAuth) lives in
  `@nessie/mcp-manage` and is shared by the API routes and the worker's
  personal-assistant `connector_*` tools — do not fork it into either side.
  Scope rules: owners manage all install scopes, admins the shared scopes,
  members their own user scope; user-scope tools auto-activate and surface only
  in the installing user's PA runs. OAuth is dynamic by default (RFC 9728/8414
  discovery, RFC 7591 client registration, PKCE, pg-backed state, auto-refresh);
  static client configs remain supported. Owners/admins can lock catalog
  entries against member self-service (install-time gate, endpoint-match
  aware). Public connector APIs never accept or return caller-chosen
  `credentialRef` values: plaintext is submitted once to the encrypted store,
  and only server-minted `secret_*` refs are persisted. Exact environment refs
  are reserved for first-party provisioning. Toolset assembly defers MCP schemas behind
  `mcp_find_tools`/`mcp_load_tools`/`mcp_drop_tools` above
  `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) to protect agent context.
  External-agent products (e.g. DeepSignal) run as a per-user DM channel with
  `Agent.executionMode = external_mcp` — turns proxy straight to the product's
  MCP endpoint with **no Nessie inference**. Load-bearing invariants: the
  system-managed, user-scoped instance resolves `DEEPSIGNAL_MCP_APP_KEY` only
  from the canonical public catalog linked from the `deepsignal`
  integrated-product row, with signing pinned to `https://api.deepsignal.live`,
  so a same-name catalog or changed origin cannot receive the key; the app key,
  the `ai.invoke` `X-UOA-Delegation`, and the fresh RS256 `X-Nessie-Context`
  are **independent** proofs carried on every call with no per-user OAuth or
  generic credential fallback; that key is distinct from every other
  secret-bearing environment credential and per-org webhook secret, verified at
  API/worker startup; pre-existing identity headers are rejected
  case-insensitively before fresh identity is attached; the signed session
  org/team must exactly match the selected team's UOA mapping (the account link
  proves only subject/status/epoch — its active org/team are non-authoritative
  last-seen metadata), DM keys include the UOA team, and legacy team-less
  channels fail closed; managed instances and their product-linked catalog
  entries reject every generic lifecycle, secret and catalog mutation.
  Generic OAuth remains available for ordinary connectors. Everything else —
  the shared `resolveInstanceMcpTransport`/`callInstanceTool` seam, the per-org
  HMAC webhook and its coalesced, budgeted rolling digest, the Signals page —
  is in [docs/external-tool-integration.md](docs/external-tool-integration.md)
  §2 + §5 and
  [docs/plans/2026-07-09-deepsignal-integration.md](docs/plans/2026-07-09-deepsignal-integration.md).
- DeepWater is usable as a tool by any permitted agent, but **default OFF with an
  explicit per-agent grant required** and **always routed through Ledger**:
  enabling DeepWater for a team (owner-only team-enablement toggle) provisions
  a **team-scoped** tool-projecting `McpServerInstance` from the `deep-water`
  catalog entry, resolves Ledger's adapter from `LEDGER_DEEPWATER_MCP_URL`
  (canonical hosted value
  `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; enable fails loudly with
  `LEDGER_DEEPWATER_MCP_URL_UNSET` when unset or
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE` when the linked first-party catalog is
  missing), installs a bearer HTTP transport using `LEDGER_PROXY_TOKEN` as
  Nessie's one deployment-wide, product-bound Ledger app API key (never a
  per-user credential), and projects
  `research_start`, `research_status`, `research_report`, `research_list`, and
  `research_cancel` as active `mcp_research_*` tools. Each sibling product must
  use its own app API key; app keys are never reused as webhook signing secrets.
  Transport authentication and caller identity are separate: every call carries
  a short-lived `X-Nessie-Context` RS256 JWT with non-null
  user/org/team/agent/run attribution and, for the linked SSO user, an
  `X-UOA-Delegation` RS256 JWT minted through UOA token exchange. The stable UOA
  subject is required for DeepWater; an optional `active` UOA org/team is
  emitted only when both values exist and never replaces Nessie's local
  tenancy. Every new renewable UOA login requires a nonnegative `tv`
  authentication epoch and binds immutable `{sub, org, team, tv}` proof into
  the signed Nessie access session and its refresh family. Nessie stores UOA's
  opaque refresh token only as AES-256-GCM server-side state coupled to that
  family; the browser receives only Nessie's unrelated rotating cookie. The
  product link proves stable subject/status/credential epoch only; its mutable
  active org/team fields are last-seen metadata, never the proof source.
  Delegation assertions and caches use the immutable session epoch and require
  exact equality with the current link and selected local team. Family/user
  advisory locks serialize rotation, replay, issuance, logout, password change,
  deactivation, and credential erasure across replicas; a replay barrier makes
  reversed predecessor/current HTTP responses converge on one cookie. UOA HTTP
  renewal runs outside database transactions between short locked preflight and
  finalize phases; if an ancestor replay wins mid-flight, finalize adopts the
  accepted UOA successor in place behind the unchanged local cookie. Login
  confirms current direct Nessie access before local mutation, product-link
  epochs never regress, and first-workspace provisioning is exact-workspace
  locked. DeepWater's product auth mode remains `uoa_sso` so first login
  creates the account link even though MCP transport auth uses Nessie's app API
  key. Generic Ledger AI calls may omit UOA delegation, but never the five-field
  local attribution; user-triggered system jobs carry their durable origin and
  derive stable named system agent/run UUIDs, failing before provider dispatch
  when origin is missing. Personal DeepWater credential overrides are forbidden
  and removed by migration, so they cannot shadow the product-bound app API key.
  Generic instance test, refresh, healthcheck, and delete operations reject the
  integration-managed instance with `MCP_INSTANCE_MANAGED_BY_INTEGRATION`;
  generic secret writes are also rejected, and PA probe/uninstall tools direct
  callers to the Integrations toggle, which is its sole lifecycle path. Ledger
  owns job isolation, budget enforcement, audit, and raw usage metering for
  both PA and shared-agent calls; UOA alone rates that usage commercially.
  `NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/openai` is the
  deployment-wide inference chokepoint for every run the ORGANIZATION pays for;
  runtime routing rewrites it to Ledger's
  `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi, or custom
  provider, including designer/orchestrator calls; embeddings resolve their own
  `/v1/:serviceId` segment (see "Embeddings" below). The one sanctioned
  exception is a **personal model subscription** (see "Personal model
  subscriptions" below): a run pinned to an agent owner's own linked plan
  bypasses this chokepoint entirely — no Ledger connection, no signed
  attribution, no Ledger metering — because the organization is not paying for
  it and its credentials are the person's, not the deployment's. That lane is
  structural, decided once at run admission, and never a fallback. If the
  deployment-wide URL is absent, signing is decided after the effective
  organization provider-record URL resolves, so a Ledger route an organization
  provider record introduced still receives complete attribution. **Inference
  signing is best-effort by deployment, mandatory once available.** With the
  `UOA_*` signer configured, every Ledger inference call signs and still fails
  closed when the originating user has no linked SSO identity. With no signer
  configured at all — an operator running on a personal Ledger API key — the
  call goes out on `NESSIE_MODEL_API_KEY` alone, because Ledger authenticates
  that bearer and decides per token whether signed provenance is also required;
  Nessie must not refuse on Ledger's behalf and force a UOA OAuth client on a
  deployment whose token does not need one. The condition is read once from
  process env at startup (`loadLedgerIdentitySettings` returning null) and is
  unreachable per request, per organization, or per user, so a signing
  deployment cannot be downgraded. This applies to model/embedding inference and
  its model catalogue only; DeepWater, `web_search`, and billing keep their own
  product-bound credentials and identity requirements unchanged.
  DeepWater `research_start` must reuse the provider's stable `tool_call_id` on
  logical retries. The projected tools and `deep_water_run_update` are flagged
  `requiresExplicitGrant`, so an agent sees them ONLY when its `toolPolicy`
  explicitly allows them (`=== true`) **and** the team-scoped instance reaches
  the run; grants never bypass tenancy, and absent/inherited denies. Owners use
  the targeted `/api/mcp/tools/.../policy-targets/...` mutation (one locked
  policy-key merge, never a full-policy replacement); canonical DeepWater rows
  take the team-transition lock, re-read their projection generation, then take
  the agent lock. Its minimal target list
  includes the Personal Assistant without exposing PA bindings/activity through
  `/api/agents`. The DeepWater launcher and
  `/api/integrations/products/deep-water/agent-access` manage/read the five MCP
  projections plus `deep_water_run_update` as an exact six-entry bundle. Launch
  stays disabled and the API rejects before run creation until the PA has 6/6;
  the updater counts only while its registry row is enabled and active, matching
  worker exposure, so a disabled builtin cannot authorize metered work;
  the final enablement/instance/policy reads and run insert are linearized under
  the team lock then agent-policy lock. Owners can also grant/revoke the bundle
  for shared agents. Generic agent create/PUT cannot write explicit-grant keys
  or DeepWater provenance markers; a locked PUT preserves them from the current
  row; clones and spawned subtask children strip them, PA bootstrap config
  cannot inject them, generic responses redact the server provenance markers,
  and Agent Designer omits their switches. Generic shared-agent create, list,
  parent selection, hierarchy/status/activity/realtime reads, and channel
  binding are exact-organization operations;
  system/global agents remain confined to dedicated bootstraps. Bundle
  provenance keeps the org-wide updater while any team/manual grant needs it;
  its individual OFF switch is disabled until those dependencies are revoked,
  while partial/drifted team projections and a disabled updater remain
  revocable. Registry callability and cleanup identity are separate: a disabled
  updater cannot satisfy readiness, but its protected allow is still removed by
  bundle revocation. Bundle and
  individual lifecycle revocation return 409 during queued/running/needs_setup
  work; there is no force override. Each
  org/team enable or disable is cross-process serialized by a PostgreSQL
  transaction-scoped advisory lock; connector rows and the product toggle
  mutate in the same transaction and roll back together on failure. Disable
  returns `LEDGER_DEEPWATER_ACTIVE_RUNS` while a queued, running, or
  `needs_setup` research run still references the connector; cancel or recover
  the run, or let it reach a terminal state, before retrying disable.
  The worker enables handoff enforcement only from server-authored message
  metadata `integrationLaunch.{productSlug,runId}` for `deep-water`; ordinary
  messages remain unguarded. The durable run lookup requires that exact run id,
  message, organization, team, and thread, and a missing/mismatched row fails
  closed. For that exact Product run, the worker atomically binds the first
  `research_start` provider tool-call id and exact arguments before transport.
  A still-clean Product run moves to `failed` only for a validated Ledger-local
  pre-start rejection (`invalid_request` 400/401, `budget_exceeded` 402, or
  `forbidden` 403), or for Nessie's own budget block while the row remains
  truly queued, uncorrelated, and undispatched. Conflicts, upstream rejections,
  5xx, malformed errors or malformed
  successful tickets, throws, timeouts, uncertain claims, and uncertain ticket
  persistence are fatal ambiguity: the Nessie run stays `running` while the
  queue retries, using the exact persisted id and arguments. A validated
  matching `rs_...` `id`/`job_id` plus exact Ledger status is persisted before
  success is returned; a retry then replays that ticket and status locally
  without another Ledger call. Managed DeepWater owns the canonical five
  `mcp_research_*` names even when private connectors collide or the grant is
  absent, so the server-authored prompt can never dispatch a foreign connector.
  Same-batch status/report/cancel calls are pinned
  to that persisted id; `research_list` and delegation stay blocked for the
  launch turn so result delivery cannot be hidden inside a timed-out sub-agent.
  Run-update/Knowledge calls remain blocked until exact start-result delivery
  and remain blocked for an abandoned timed-out attempt.
  The start result is acknowledged with its invocation-specific delivery token
  only after connector telemetry and tool-end recording settle and its tool
  message is incorporated; timeouts during definitive-failure persistence or
  pending result delivery therefore stay fatal and retry-safe.
  Ordinary setup, inference, and callback failures are promoted to that fatal
  path while the handoff remains unresolved. A budget block may fail only a
  truly uncorrelated queued Product row before terminalizing the Nessie run;
  correlated running work remains recovery-safe, and a terminal claim race
  quarantines a still-clean row. A late definitive rejection may move only the
  exact correlated `needs_setup` row to `failed`.
  Missing or duplicate exact handoff rows fail closed before inference;
  on retry exhaustion every clean exact candidate moves to `needs_setup`, while
  rows carrying external/dispatch/report/Knowledge evidence are preserved. A
  validated ticket that arrives after final-attempt recovery still attaches
  atomically, clears the stale recovery detail, preserves its exact Ledger
  status, and keeps the Product run `running` until mandatory terminal
  reconciliation, so accepted provider work is neither orphaned nor prematurely
  unblocked by the timeout race. Fatal
  tool calls still emit their paired sanitized end event, and every started
  same-batch tool wrapper settles before the queue attempt is released.
  Completion also fails fatally if the model omits the required start. Ordinary
  DeepWater calls are unchanged.
  PA message, run attachment, PA run/task, and direct `run.execute` enqueue
  commit atomically; product handoffs bypass chat engagement decisions while
  ordinary chat keeps its existing orchestration path. Duplicate enqueue
  conflicts roll back the duplicate unit, and realtime publication is
  post-commit/non-fatal.
  Even a
  null external id remains a conservative blocker because Ledger dispatch may
  be in flight; the error links an attached chat where PA can call
  `research_cancel`, while unattached interrupted work requires explicit
  recovery. Disable
  targets only the instance linked from the first-party public product, so
  private same-name catalogs are untouched. `deep_water_run_update` is not
  PA-only and takes tenancy strictly from the run context (same team + thread;
  Knowledge page validated against the org). It never accepts a cost, price,
  charge, tariff, or currency: Ledger's DeepWater REST/MCP status, report, and
  list contracts expose no commercial amount, and UOA is the sole commercial
  authority.
  The external report URL is persisted only from Ledger's authenticated
  `research_start` structured response after its origin and exact job path are
  validated; source count is persisted only from the authenticated
  `research_report` references array. Both carry server-only provenance markers
  before they are exposed, and agent-authored run updates cannot set, replace,
  or mark either value as trusted. Source persistence atomically repairs an
  already-created exact per-run connector usage event, making same-batch
  report/update order irrelevant. That event records operational calls and
  authenticated source units against the launch run's immutable
  `requestedByUserId`; it has no cost fields and is excluded from every local
  cost aggregate. Migration
  `20260720234500_retire_deepwater_local_cost_mirror` erases historical local
  amounts, converts only their existence into a cost-free server-only dispatch
  recovery marker, drops the obsolete Product-run cost columns, and installs a
  database trigger rejecting future DeepWater connector-event cost writes.
  Product run APIs and UI expose no DeepWater cost; customer totals
  come only from UOA's statement.
  The locked write also enforces a terminal start ticket's exact Product status
  mapping (`complete` → `completed`; negative terminal outcomes → `failed`).
  Re-enable preserves richer probed schemas only
  when tool names exactly match the current Ledger contract; legacy
  direct-provider projections are replaced and must be explicitly re-granted.
- Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
  and Stripe
  lifecycle remain authoritative in UOA. Ledger's raw reporting endpoint is
  UOA-only: Nessie must not hold a metering-reader key, call Ledger's legacy
  billing route, or expose a parallel raw-billing panel. Nessie's product-bound
  Ledger app key is only for its paid inference, DeepWater, Serper, and other
  metered execution calls; UOA independently reads Ledger and supplies the
  customer-facing service/team/user breakdown. The canonical UOA customer
  statement, Checkout, Portal, and
  cancellation preview/confirm use a different, Nessie-only
  `UOA_BILLING_APP_KEY_NESSIE` plus a fresh 45-second RS256 actor assertion
  signed by `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`. Both secrets are
  cryptographically validated on the Actions runner, then installed together by
  a dependency-free host script in the main-branch deployment workflow; neither
  may be reused by Ledger or a sibling product. The actor assertion carries the
  signed session's UOA `tv` epoch—not a value recovered from a mutable account
  link—for UOA's online credential-revocation check. Every request resolves the exact
  linked UOA user/org/team, rejects local workspace drift, and lets UOA
  independently recheck billing-manager membership. The public
  protocol is consumed from the MIT-licensed
  `@unlikeotherai/billing-statement-protocol` 1.2.0 package, vendored
  byte-for-byte from UOA commit
  `272e4d95846788f752d1e623d5f69f7c961f1dc5` and protected by a root SHA-256
  verification gate. API validation uses its exported JSON Schemas and the
  admin imports its exported view-model types; local editable copies are
  forbidden. `/schemas/billing-statement-v2.json` is display-ready: Nessie
  renders its plan, markup, line items, totals, and the complete
  connected-service team/origin/user portfolio from one exact Ledger
  `metering-portfolio-v1` `group_by=user` snapshot without rating, aggregation,
  share calculation, or cancellation reasoning. Frozen customer actions remain
  on the version-1 action contract. For actions the API re-fetches the statement,
  accepts only the
  frozen action-id/path pair, verifies its subject, and forwards UOA's
  server-produced body unchanged. Browser-supplied action bodies and return URLs
  are forbidden. Cancellation relays only UOA's opaque short-lived preview
  token, UOA idempotency key, and selected UOA choice; UOA locks and revalidates
  team-wide direct access before confirming. Nessie stores no tariff, Stripe
  customer, subscription, invoice, Price, credit balance, top-up policy,
  payment consent, recurring add-on, statement, or cancellation state. Every
  active exact-team member may read the same UOA-owned team credit account.
  The display leads with remaining credits, then pending/added/used credits,
  connected-service usage, recent activity, and automatic top-up status. UOA
  fixes 1,000 credits to US$1 and returns display-ready values; Nessie never
  converts tokens, raw Ledger units, provider cost, or money into credits.
  Billing managers receive named-user/payment detail and frozen top-up,
  automatic-top-up, and recurring-add-on actions. Ordinary members receive a
  privacy-safe read-only projection with their own usage plus anonymous
  other-member and unattributed totals. Their pending-payment amount and
  funding policy are absent; automatic top-up exposes only UOA's payment-method
  status and directs detailed settings to billing managers. Every mutation
  re-fetches the UOA view,
  validates the exact frozen action, and relays it unchanged.
  `/tokens` is the customer Credits & Billing surface and contains only these
  UOA-authored models. Nessie's owner-only local token, pricing, estimate,
  projection, connector, file, and budget telemetry is isolated at
  `/ops/usage`; it must never be rendered beside customer credits or statements.
  Integrated-product APIs do not query or return local usage summaries.
  A successful direct Nessie SSO exchange confirms `nessie` access through
  UOA's exact `/billing/v1/service-access/confirm` seam before Nessie issues its
  local session; the call is bound to the linked user/org/team and fails login
  closed unless UOA returns `204` with `no-store`. Connector, DeepWater, agent,
  and other indirect execution paths never create this direct-access evidence.
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
- The Individual Communications Connector wires per-user OAuth connections
  (Slack + Gmail live, Microsoft planned) into a normalized `CommsEvent` store
  through the provider-agnostic `@nessie/comms-connect` core and one adapter
  package per provider. Adapters register into the shared registry only via
  `@nessie/comms-providers` (`registerCommsConnectorsFromEnv`), called at API
  and worker startup from `NESSIE_COMMS_*` env; unset providers stay
  unregistered and their jobs park on `ConnectorNotRegisteredError`. Token
  bundles are encrypted in a separate table (never returned to the browser),
  sync is resumable + checkpointed with webhook ingestion through the worker
  queue, and the connector layer carries **no** reasoning logic (Chief-of-Staff
  boundary). The sync worker and subscription-renewal sweep skip any connection
  whose owner is no longer an active org member (`deactivatedAt`), so user
  deactivation revokes comms import immediately — matching the API auth and
  scheduled-trigger owner-revocation gates. Spec:
  `docs/plans/2026-07-21-individual-communications-connector.md`.
- **A provider scope is a capability in one catalog, and every check on it
  fails closed.** Google's scopes live in
  `packages/schemas/src/google-capabilities.ts` and nowhere else. Three fixes
  make the checks trustworthy, each closing a real fail-open: `grantedScopes`
  is read from the token response and a response with no `scope` is refused
  (it used to fall back to the *requested* scopes, recording authority a
  person had un-ticked on the consent screen); account identity comes from the
  OIDC `id_token`, not Gmail's `users.getProfile`, which needs a Gmail read
  scope and therefore made a calendar-only or send-only connection impossible;
  and HTTP 403 is classified by Google's machine reason, so
  `insufficientPermissions` is fatal and surfaces as a request to grant the
  capability instead of retrying until the job dies. Capability checks are
  all-of at the one `loadUserGoogleCommsCredential` chokepoint, which also
  enforces local blocks and refuses two qualifying accounts rather than
  guessing. A local block is not a revocation — a provider grant can only be
  revoked whole — so it is enforced server-side and the copy says so. OAuth
  state binds the connection being widened and the expected provider account,
  because a callback that trusts whoever finished consent will silently
  re-point a different mailbox. Plan:
  `docs/plans/2026-08-31-google-workspace-email-calendar.md`.
- **An approval over provider content binds the content, not its handle, and
  the gate is code rather than data.** Hashing a Gmail draft's *id* authorises
  nothing useful: the draft stays mutable through the chat card, through Gmail,
  and through another run, so an approved send could deliver text nobody
  approved. `GmailDraftAction.contentFingerprint` is re-read and compared on
  every send path, and the same row carries the conditional
  `draft → sending → sent` claim that makes a double send impossible. The
  approval requirement itself is declared on the tool definition and enforced at
  the tool chokepoint, because `evaluateToolInvokePolicy` defaults to `allow`
  and a seeded-`PolicyRule` gate is therefore absent in any organisation whose
  seed never ran. Its only bypass is an exact-key standing grant
  (`SendAuthorizationGrant`, `(connectionId, agentId)`, the
  `ScopeDisclosureGrant` shape) that never covers an unattended run or a
  non-owner, and `ApprovalRequest.requiredApproverUserId` keeps a send-as-you
  gate resolvable only by the person it acts as — approval visibility otherwise
  reaches every member who can read a public channel. One shared
  `sendDraftForUser` serves the human button and the agent tool; api services
  are unreachable from the worker, so a second copy forks the state claim and
  the audit trail on day one. Details: `CLAUDE.md` → the Google bullets.

## Personal model subscriptions — the owner's plan, the owner's grant

A person links a consumer AI plan they already pay for (Kimi and GLM today;
OpenAI Codex and xAI Grok when the OAuth phase lands) and the agents **they
own** run on it instead of the organization's Ledger credits. Rules that must
not drift:

- **A link is Nessie's own grant.** Never read, import, or accept a vendor
  CLI's stored credentials (`~/.codex/auth.json`, `~/.grok/auth.json`, keychain
  items): providers rotate refresh tokens and invalidate the previous one, so
  two apps sharing one grant log each other out. One grant, one refresh owner.
- **Token values live in the vault, never in PostgreSQL**, in a **dedicated,
  separately-ACLed** vault project (`NESSIE_SUBSCRIPTION_VAULT_*`) rather than
  the shared personal partition, which also holds a person's ordinary captured
  secrets. `model_subscription_credentials` holds only the pointer, and a
  deployment with no vault refuses linking in words — never a column fallback.
  Deleting a pointer tombstones the vault secret in the same transaction, or a
  cascade strands a live refresh token nothing can address.
- **The lane is pinned at run admission and never falls back.**
  `resolveRunSubscriptionBinding` re-derives entitlement from live rows and
  persists the subscription plus its credential epoch on the `Run`, so a
  mid-run relink cannot switch accounts and a continuation whose binding died
  fails closed. Anything that merely *looks* like a subscription — unknown
  adapter, dangling pointer — is `unavailable`, never Ledger: falling back
  would move a person's spend onto the organization with nobody agreeing to it.
- **Organization budgets gate organization spend, so they do not gate this
  lane.** `applyBudgetGate` and its mid-run probe skip a pinned run: blocking
  would refuse a run the organization is not paying for, and a `degrade`
  verdict would rewrite it onto the organization's Ledger provider — moving the
  very spend it was capping. The per-run backstop envelope still applies.
- **Exclusion from cost is structural**: `TokenLedgerEvent.billingSource` +
  `modelSubscriptionId` decide it, never the absence of a pricing profile.
  Attribution follows the subscription **owner**, not whoever posted, and the
  writer reads the run's own pin so no terminal path can forget to stamp it.
- **One validator, every write path.** `assertAgentModelSelection`
  (`@nessie/workspace-admin`) gates create, update, clone and the PA
  `agent_create` tool; ownership transfer and clone strip the selection,
  because a subscription is not transferable. Write-time validation is UX; the
  run-time gate is the security boundary.
- **Refresh discipline:** a short locked claim, the network call outside any
  transaction, compare-and-swap on the epoch, never a transport-failure retry
  of a refresh grant, a 5-minute proactive margin, and failure transitions
  applied only while the failing epoch is still current. Only adapter-defined
  authentication codes reach `needs_reauthorization` — 403 is also entitlement,
  policy and quota, which a relink button cannot fix.

Rationale, field lessons and phasing:
[docs/plans/2026-09-02-personal-model-subscriptions.md](docs/plans/2026-09-02-personal-model-subscriptions.md).

## Embeddings — routed separately, one pinned width

- Embeddings are configured independently of chat via `NESSIE_EMBEDDING_*` (`PROVIDER`, `MODEL`, `SERVICE_ID`, `BASE_URL`, `API_KEY`); every unset field inherits the chat provider, so an unconfigured deployment is byte-identical to before. The chat provider may serve no embeddings endpoint at all — Ledger's DeepSeek adapter answers `403 embeddings is not allowed for deepseek` — so production embeds through `/v1/jina` while chat stays on `/v1/deepseek`. Resolution lives in `packages/runtime/src/inference/embedding-provider.ts` and is applied once in `createModelClient`; do not fetch embeddings through any other path. Signed `X-Nessie-Context` / `X-UOA-Delegation` identity travels with the embedding leg only while it stays on the chat host, so a third-party embedding endpoint an operator names never receives a delegation assertion.
- **`EMBEDDING_DIMENSIONS` (`packages/schemas/src/embedding.ts`) is the single source of truth for the vector width** (currently 1024, `jina-embeddings-v3`'s native width). Never write the number anywhere else — not in a producer, a validator, a test fixture, or the mock-LLM harness. The three pgvector columns (`thoughts.embedding`, `thought_recalls.query_embedding`, `knowledge_page_chunks.embedding`) are declared at that width, and every embed request sends `dimensions` so a provider answering differently fails loudly. Changing the embedding model to another width = edit the constant + one Prisma migration re-typing the columns + re-embedding; vectors of different widths are not convertible, so the migration nulls them rather than truncating (a truncated vector is neither model's output and poisons later comparisons).
- The model that produced a vector is `ModelClient.embeddingModel`, resolved from deployment config — not a constant. It is what gets written to `embedding_model` and what keys the query-embedding cache, so the two sides of a similarity comparison agree by construction rather than by two constants happening to match.
- Spec: `docs/deployment.md` "Embedding model and vector width".

## File storage & accounting — single chokepoint

- **All blob file operations** — store, stream, download, delete, version, attachment-linking — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`.
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- JPEG/PNG/WebP uploads have EXIF/GPS metadata stripped at the `FileService` store chokepoint (EXIF orientation applied to the pixels first, ICC profiles preserved, accounting records the post-strip size); orgs opt out via `Organization.stripImageMetadata`, and images over 50 MiB or undecodable pass through unchanged to keep uploads streaming.
- **A previewable upload also owns a thumbnail** (`<storageKey>.thumb.webp`), derived at the same chokepoint: inline for raster images, via the `attachment.thumbnail` worker job for PDFs (first page, `@hyzyla/pdfium` — pure WASM, no native deps; AGPL/GPL renderers are disqualified), animated/exotic images, oversized images, and strip opt-outs. It is quota-gated with the original, carries its own `store.thumbnail` / `delete.thumbnail` usage events, and is freed by `FileService.delete` — the single place attachment bytes are removed, so nothing can leak it. Generation failures are never fatal (`thumbnailStatus = unavailable`, clients fall back to the original); existing attachments are not backfilled. Attachment downloads and thumbnails are served with `private, max-age=1y, immutable` + a strong `ETag`, with `If-None-Match` answered as a 304, because attachment bytes are immutable. Spec: `docs/plans/2026-08-06-attachment-thumbnails-and-previews.md`.
- **A run's context window carries its messages' attachments.** Every turn gets an inventory line appended at render time (kept beside `Message.content`, never inside it, so the prompt builder's raw-content comparison still matches), and `user` turns carry inlined image bytes on `ProviderMessage.images`. Bytes come from the same `FileService` chokepoint — original for a PNG/JPEG/WebP/GIF ≤ 4 MiB, else the stored `.thumb.webp`, else nothing — capped at 6 images per prompt (newest first), non-fatal on failure, and estimated for the context window. Whether they reach the wire is the connector's call, gated on its own truthful `supportsVision` (`openai`/`openai-compatible` yes; `deepseek`/`kimi` no, keeping the inventory line). The engagement orchestrator reads the same line so an image-only post can start a run; the judgement itself stays model-made. Logic lives in `worker/src/run/message-attachments.ts` — do not fetch attachment bytes for prompts anywhere else. Spec: `docs/plans/2026-08-07-images-in-agent-context.md`.
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See `docs/deployment.md`.
