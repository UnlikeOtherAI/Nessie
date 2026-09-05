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
   reuses the knowledge team. A second implementation of the same view is a
   defect, not a feature. The same holds one level down, for controls: the
   admin's single-select strip is `components/primitives/TabBar.tsx` and every
   avatar is drawn by `components/primitives/IdentityTile.tsx` — each replaced
   a crowd of drifted look-alikes (nine tab bars; seventeen identity tiles
   across twelve radii, which is also what had the Personal Assistant rendering
   as a portrait in the sidebar and a lightning bolt in the thread panel). The
   collapse histories live in
   [docs/standards/design-system.md](docs/standards/design-system.md).

A new server capability ships with its surface in the same change, or with a
deliberate, written decision that it is machine-only. "The API exists" is not a
delivery.

## Navigation — one framework

Anything that moves a person between screens, opens an overlay, or handles
Back goes through the navigation framework — read `docs/navigation/overview.md` first.
It is the only way, and adding a second one is the defect Rule zero names.

## Workflow

- Worktrees are mandatory. The main project checkout always stays on `main`; never edit it directly. Every task — and every parallel agent/CLI — works in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never reset, clean, or discard another worktree's or agent's work.
- **`main` is protected: every change lands through a pull request, and only a green one can merge.** Nothing pushes to `main` directly — the branch rejects it, for admins too. When a task is done, push the branch and open a PR (`gh pr create`). All eight CI jobs are required checks (Lint, Type Check, Build, Test, Upgrade Path, Mock-LLM Smoke, Navigation Transitions, Linux Desktop Bundle), and CI runs on the branch push, so the checks are already reporting by the time the PR exists. The eight run **in parallel** — no job declares `needs` — so a red Lint no longer hides whether the tests passed, and the merge gate is the required-check list rather than job ordering. Each job resolves its own scope through `scripts/ci-scope.mjs`: on a branch, Turbo tasks are narrowed with `--affected`, and the desktop bundle and the browser/smoke suites are skipped when their inputs did not change. Any root-level change (lockfile, root config, `scripts/`, `.github/`) and every push to `main` forces a full unfiltered run, because `--affected` compares package directories only and would otherwise select nothing. Turbo's filesystem cache is restored per job via `actions/cache`, which is what keeps the serial `^typecheck` chain cheap — do not remove that chain to parallelise it, as it is also what puts a package's dependencies into its typecheck cache hash. **No human approval is required: merge as soon as the checks are green** (`gh pr merge --merge`), in the same turn — do not leave finished work parked in a PR unless the user says otherwise or verification is blocked. Then in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch. Branches are not required to be up to date with `main` before merging: merge traffic is heavy and forcing a re-sync per merge would serialise everything. This gate exists because a stale test once kept `main`'s CI red for 25 consecutive merges while the separate Deploy workflow shipped every one of them.
- Commit and push after every turn. No exceptions. If there is nothing to commit, skip.
- Local dev runs with hot reload via `pnpm dev` (root) — API (5454, nodemon) + admin (5455, Vite HMR) in parallel. (Moved from 5554/5555 to dodge an Android emulator squatting on those ports; production internal port stays 5554.) Admin and API source edits reload automatically; **do not hand-build the admin to see changes.** The repo sits on a macOS data-volume path where fsevents is dead, so watchers must poll: Vite `server.watch.usePolling` and `nodemon --legacy-watch`. Don't remove these.
- **Build:** Install a release on the named device.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- `pnpm --filter @nessie/admin build` is for production/CI bundles only, not the dev loop.
- **Desktop bundles, macOS signing (never ad-hoc unless Ondrej explicitly asks), lint-gated root builds, Prisma generation ordering, and migration immutability:** read [docs/standards/build-and-release.md](docs/standards/build-and-release.md) before building a desktop app, changing a build pipeline or Dockerfile, or touching `api/prisma/migrations/`.
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.
- Run package tests through Turbo (`pnpm test`, or `pnpm exec turbo run test --filter=<pkg>`) **with `DATABASE_URL` exported for that run** — unset, every Postgres-backed suite silently skips and the run is green with zero database coverage.
- **The full testing standard** — why only the Turbo path is valid, the deliberate worker-before-api ordering, process/memory limits, the shared-database discipline (no global mutations, counts, or poller assumptions), Prisma-fake obligations, and the mock-LLM harness: read [docs/standards/testing.md](docs/standards/testing.md) before writing or debugging any test.

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
- Everything else — desktop and App Store bundles, signing, lint-gated root
  builds, Prisma generation ordering, migration immutability:
  [docs/standards/build-and-release.md](docs/standards/build-and-release.md).

## Production deployment

- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers behind the host's shared Caddy edge proxy. It is **not** GCP
  Cloud Run — the old GCP workflow/spec are retired
  ([docs/phase2-gcp-deployment-spec.md](docs/phase2-gcp-deployment-spec.md)
  is historical).
- URLs: public web `https://nessie.works`, admin `https://app.nessie.works`,
  API `https://api.nessie.works`.
- **Authoritative guide: [docs/deployment.md](docs/deployment.md)** — first
  deploy, redeploy, the container stack and compose files, proxy trust,
  config reference, MCP secret store, and SSO status.

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

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
- **This file and `CLAUDE.md` carry only what every session needs.** A rule
  that belongs to one subsystem or one activity lives in its own file —
  `docs/standards/` for standards, `docs/` for guides and specs — and appears
  here as a one-sentence signpost plus a link. Growing an inline section
  instead of routing it is the defect this structure exists to prevent.

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
- **Desktop** (`desktop/`) — Tauri shell for the hosted admin. Developer ID releases include the local executor; the sandboxed Mac App Store/TestFlight variant deliberately does not. Signing policy and build recipes: [docs/standards/build-and-release.md](docs/standards/build-and-release.md).
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
- Legacy code lives in `src/` — the old single-user server, being removed; do
  not rely on it for new work and do not import from it. (It still registers
  `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch; the new `api/`
  server does not.) New code goes into `api/`, `admin/`, `web/`, `worker/`,
  `packages/`; reusable concepts are re-implemented in `packages/`.
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
  UOA organisation is one Nessie `Organization` (bound by the unique
  `Organization.externalOrgId`), and one UOA **team** is one **team** inside
  it — a team IS the UOA team; a project is Nessie's own and lives inside one.
  Flattening several UOA organisations into one local container, or keeping any
  second local copy of the org hierarchy, is the same violation as duplicating
  identity rows, with the same remedy: an API-backed refactor plus a data
  migration, never a compatibility copy. Creation, renames, the unbound no-IdP
  install, route families, and the standing duplication gaps:
  read [docs/standards/team-model.md](docs/standards/team-model.md) before
  writing code here — the local model is still called `Team` and its
  `projectId` foreign key currently points the wrong way. The rule itself
  lives in `docs/brief.md` → "Current SSO identity invariant".
- **A team is reachable at `<team>.<org>.<base domain>`, and Nessie stores
  neither label.** The organisation slug is the tenant DNS key and the team slug
  is unique only inside it, so a flat `<team>.<base>` is forbidden rather than
  merely discouraged. Resolving a hostname is a lookup that grants nothing — the
  team switch that follows is the authorization — and matching one is a
  label comparison, never a suffix test, or `evil-nessie.works` passes. The edge
  needs one DNS record and one wildcard certificate **per organisation**, and
  why it is per organisation rather than per team is a rate limit with teeth:
  read [docs/standards/team-hosts.md](docs/standards/team-hosts.md) before
  touching host routing, CORS, or the edge.
- **Automatic team access by verified email domain — Nessie holds the policy,
  UOA still authorizes every grant.** Every grant is a relay to `addTeamMember`
  carrying a fresh org-scoped subject assertion for the administrator who
  authorized the rule — never backend mode, never a local membership write; no
  call names a role and no path removes a membership.
  Read
  [docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md](docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md)
  before writing code here.
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
- **Project boards are views, never containers.** A project has many
  `Board`s over one task pool; `Task.status` stays the single lifecycle truth
  and a board placement is a `TaskBoardPlacement` pin over it that is ignored
  once its column's category no longer matches. Placement is resolved
  server-side by `resolveBoardPlacement` (`@nessie/team-admin`) — never in the
  client — and board/column/field/source administration is gated by
  `canAdministerProject`, not organisation ownership.
  Read [docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/overview.md](docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
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
- **Outbound egress is IP-pinned, not just validated.** Anything reaching a
  caller-, operator- or model-supplied address goes through `@nessie/runtime`
  `safeFetch`/`pinnedFetch` (raw sockets through `resolveVettedAddresses`);
  the root `eslint.config.js` egress block bans global `fetch` as the ratchet.
  Read [`docs/standards/egress.md`](docs/standards/egress.md)
  before writing code that dials out.
- **Nothing a second instance cannot see.** The API and the worker run as N
  replicas: no module-scope mutable state, every periodic job claims its work
  or takes `withSweepLock`, every run is fenced and resumable, `SIGTERM` drains
  inside sixty seconds, and realtime persists and notifies in one transaction;
  the horizontal-scaling block in the root `eslint.config.js` is the ratchet.
  Read [`docs/standards/horizontal-scaling.md`](docs/standards/horizontal-scaling.md)
  before writing code here.
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
- **Builtin `web_search` is a Ledger-only Serper route.** Every call posts to
  Ledger's `/v1/serper/search` with signed provenance; direct
  `google.serper.dev` calls and `SERPER_API_KEY` fallbacks are forbidden.
  Read [`docs/standards/web-search.md`](docs/standards/web-search.md)
  before writing code here.
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

Embeddings are configured independently of chat (`NESSIE_EMBEDDING_*`,
resolved once in `createModelClient`), and
`EMBEDDING_DIMENSIONS` is the single source of truth for the vector width —
never write the number anywhere else.
Read [`docs/standards/embeddings.md`](docs/standards/embeddings.md)
before writing code here.

## File storage & accounting — single chokepoint

All blob file operations go through the one `@nessie/runtime` `FileService`,
and storage accounting is part of the file op, never optional; uploads stream,
previewable uploads own a thumbnail, and a run's context carries its messages'
attachments through the same chokepoint.
Read [`docs/standards/file-storage.md`](docs/standards/file-storage.md)
before writing code here.

## Agent documents — one shared home provisioner

Knowledge-space provisioning lives in `@nessie/knowledge`
(`packages/knowledge/src/provisioning.ts`); at run setup a non-system agent
with an assembled KB write tool lazily gets its private `<Agent> — Documents`
home, and the system prompt injects that home id so the model never invents a
`spaceId`.
Read [`docs/standards/agent-documents.md`](docs/standards/agent-documents.md)
before writing code here.

## Cloud browsers — a second transport, not a second browser surface

Agents drive a real Chromium in the cloud (Browserbase) as well as the one the executor runs on a person's machine (phase 1 shipped 2026-09-02). The browser verbs are the executor's own closed grammar reused verbatim under their own `requiresExplicitGrant` key; connection scope follows the surface that accepted the key; and because browser-hours are money, release is fused to `updateRunStatus` while a reaper stops strays by calling Browserbase. Those invariants, their rationale and the as-built deltas (§5a) live in [docs/plans/2026-09-02-browserbase-cloud-browsers.md](docs/plans/2026-09-02-browserbase-cloud-browsers.md) — read it before touching this.

## Settings — one cascade, and a lock a person can see

A setting that exists at more than one level resolves through `ScopedSetting`
(`@nessie/runtime` `scoped-settings.ts`): organisation → team → person, most
specific wins, stopping at the first level marked `locked`. A lock may carry no
value, pinning whatever resolved above it, and the level that locked it comes
back with the answer so the surface greys the control and names it rather than
accepting an edit the server would refuse.
Read [`docs/standards/scoped-settings.md`](docs/standards/scoped-settings.md)
before writing code here.

## Message reply threads (#233)

Slack-style reply threads live one level deep on `Message.rootMessageId`;
where a run's reply lands is decided before the run starts, and **where a run
replies and what it reads are separate questions**. Thinking bubbles and the
client-only liveness hint are part of the same standard.
Read [`docs/standards/reply-threads.md`](docs/standards/reply-threads.md)
before writing code here.

## Web Push & user alerts

Browser Web Push is a second push transport alongside native APNs/FCM, with
crypto in-process (`packages/push`, RFC 8291/8292) — authoritative guide:
[docs/web-push.md](docs/web-push.md). Direct @mentions write durable
per-recipient `UserAlert` rows (mute suppresses push, never the row);
read [`docs/standards/user-alerts.md`](docs/standards/user-alerts.md)
before writing code here.

## Provider-linked calls + ringing

Calls are provider links (Meet/Jitsi/Teams), never an embedded media surface;
realtime publishes one message per audience, and push never carries an
external meeting URI. `meeting_link_create` and `call_start` are PA-only
builtins mirroring the routes.
Read [`docs/standards/calls.md`](docs/standards/calls.md)
before writing code here.

## Docs

- [brief.md](docs/brief.md) — Historical architecture brief (see banner)
- [build-ai-coworker.md](docs/done/build-ai-coworker.md) — Historical macOS app build plan (moved to done/)
- [context-window-optimization-audit.md](docs/context-window-optimization-audit.md) — Audit + prioritized roadmap for LLM context-window usage in the agentic run pipeline
- [known-limitations.md](docs/known-limitations.md) — Code-verified register of current limitations (status taxonomy; two fixes in flight as of 2026-07-23)
- Finished documents belong in `docs/done/`.
