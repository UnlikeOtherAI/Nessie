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
- **`main` is protected: every change lands through a pull request, and only a green one can merge.** Nothing pushes to `main` directly — the branch rejects it, for admins too. When a task is done, push the branch and open a PR (`gh pr create`). All ten CI jobs are required checks — Lint, Type Check, Build, Test, Upgrade Path, Mock-LLM Smoke, Linux Desktop Bundle, Multi-Instance Smoke, Windows Native, and the three-leg `Production Image {app,admin,web}` matrix, which is twelve check names for ten jobs — and CI runs on the branch push, so the checks are already reporting by the time the PR exists. They run **in parallel** — no job declares `needs` — so a red Lint no longer hides whether the tests passed, and the merge gate is the required-check list rather than job ordering. **`Production Image` builds the three Deploy Dockerfiles without pushing them**, because every other check compiles the workspace on the runner with the whole repo on disk, while the images build from a partial context each Dockerfile assembles by hand — so anything a context omits used to surface only in Deploy, after merge. An import of `scripts/dev-ports.mjs` added to `admin/vite.config.ts` passed all nine checks, merged, and then broke production promotion. **The browser end-to-end suites are not among them.** Navigation Transitions — which runs the private-conversation disclosure evaluation first, then navigation, the fixed-port project-usability lifecycle runner, connected mail, mailbox onboarding, agent conversations and executor pairing/management — is the longest job in the estate and now lives in its own `Browser Suites` workflow, run **on request** (`gh workflow run browser-suites.yml --ref <branch>`, or the Actions tab). It is no longer a required status check, because a required check that never reports blocks a pull request forever. The consequence is worth stating plainly: **nothing catches a navigation or browser regression before it reaches `main` unless somebody asks for it.** Run it on a branch that touches the admin shell, navigation surfaces, the mailbox or the documents browser. Each job resolves its own scope through `scripts/ci-scope.mjs`: on a branch, Turbo tasks are narrowed with `--affected`, and the desktop bundle and the browser/smoke suites are skipped when their inputs did not change. Any root-level change (lockfile, root config, `scripts/`, `.github/`) and every push to `main` forces a full unfiltered run, because `--affected` compares package directories only and would otherwise select nothing. Turbo's filesystem cache is restored per job via `actions/cache`, which is what keeps the serial `^typecheck` chain cheap — do not remove that chain to parallelise it, as it is also what puts a package's dependencies into its typecheck cache hash. **No human approval is required: merge as soon as the checks are green** (`gh pr merge --merge`), in the same turn — do not leave finished work parked in a PR unless the user says otherwise or verification is blocked. Then in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch. **Removing a worktree deletes everything inside it, so nothing durable may live there** — the local database once did, as a bind mount under `.nessie/docker/postgres`, and a routine removal destroyed the entire local install without one loud failure. The rule and the one-time migration are in [docs/standards/local-state.md](docs/standards/local-state.md); `pnpm lint` enforces it. Branches are not required to be up to date with `main` before merging: merge traffic is heavy and forcing a re-sync per merge would serialise everything. This gate exists because a stale test once kept `main`'s CI red for 25 consecutive merges while the separate Deploy workflow shipped every one of them.
- Commit and push after every turn. No exceptions. If there is nothing to commit, skip.
- **Production promotion is exact-SHA gated.** The serialized Deploy workflow
  promotes the newest commit on `main` that has its own successful trusted main
  CI run — the tip when the tip's CI is green, otherwise the newest verified
  ancestor, because requiring the tip itself stalled production for hours under
  merge traffic. Automatic and manual dispatches use the same gate, and a run
  that promotes nothing says so in its title and summary. Read
  [`docs/deployment/redeploying.md`](docs/deployment/redeploying.md) before
  changing deployment automation.
- Local dev runs with hot reload via `pnpm dev` (root) — API (nodemon) + admin (Vite HMR) in parallel, on this worktree's ports (5454/5455 by default; see "Ports"). (Defaults moved from 5554/5555 to dodge an Android emulator squatting on those ports; production internal port stays 5554.) Admin and API source edits reload automatically; **do not hand-build the admin to see changes.** The repo sits on a macOS data-volume path where fsevents is dead, so watchers must poll: Vite `server.watch.usePolling` and `nodemon --legacy-watch`. Don't remove these.
- **Build:** Install a release on the named device.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- `pnpm --filter @nessie/admin build` is for production/CI bundles only, not the dev loop.
- **Member-management browser fixture builds:** the Navigation Transitions job alone enables its preview entry; ordinary bundles omit it. Read [`docs/testing/member-management-e2e.md`](docs/testing/member-management-e2e.md) before changing that evaluation or its build cache inputs.
- **Durable local state — the dev database, uploaded bytes — lives outside the checkout, never inside a worktree, and is shared by all of them:** read [docs/standards/local-state.md](docs/standards/local-state.md) before changing `infrastructure/compose/docker-compose.yml`, the storage paths in `packages/config` or `packages/runtime`, or anything else that writes state a person would mind losing.
- **Desktop bundles, macOS signing (never ad-hoc unless Ondrej explicitly asks), the Developer ID signed and notarized executor menu bar DMG, lint-gated root builds, Prisma generation ordering, and migration immutability:** read [docs/standards/build-and-release.md](docs/standards/build-and-release.md) before building a desktop app or an installer, changing a build pipeline or Dockerfile, or touching `api/prisma/migrations/`.
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.
- **Private Deep.Agent package access.** CI and Docker use the externally
  managed `DEEP_AGENT_READ_TOKEN` (fine-grained `deep.agent` Contents:Read);
  never commit, log or persist it.
- Run package tests through Turbo (`pnpm test`, or `pnpm exec turbo run test --filter=<pkg>`) **with `DATABASE_URL` exported for that run** — unset, every Postgres-backed suite silently skips and the run is green with zero database coverage.
- **The full testing standard** — why only the Turbo path is valid, the deliberate worker-before-api ordering, process/memory limits, the shared-database discipline (no global mutations, counts, or poller assumptions), Prisma-fake obligations, the mock-LLM harness, and the local SMTP/IMAP wire smoke: read [docs/standards/testing.md](docs/standards/testing.md) before writing or debugging any test.

## Ports

- **Defaults: API `5454`, admin `5455`.** A checkout that sets nothing binds
  these, and UI verification is then `http://localhost:5455`.
- **A worktree may take its own pair, and should whenever the defaults are
  busy.** Set `NESSIE_API_PORT` and `NESSIE_ADMIN_PORT` — in the environment,
  or as `KEY=VALUE` lines in the repo root `.env`, which is the same file the
  API's dev script loads. Both are resolved in exactly one place,
  [`scripts/dev-ports.mjs`](scripts/dev-ports.mjs), which the `predev` guard,
  the Vite dev/preview server, the `/api` proxy, the executor's pairing origin
  and the browser harnesses all read. Move the pair there and the whole
  worktree moves with it; never hardcode a port beside that resolver.
- **Within one worktree the pair is fixed.** Do not restart either service on a
  different port than the one it came up on — the admin proxies `/api` to the
  API port resolved at startup, so a mid-session move points the browser at one
  instance and its data at another.
- **Never take a port another worktree is on.** `predev` probes first and
  refuses rather than killing anything: it names the holding process (`lsof`,
  or `netstat`/`tasklist` on Windows) and the variable to set instead. Killing
  the holder destroys a parallel session's dev loop, and adopting its server
  means verifying a change against a checkout that does not contain it.
- Defaults moved from 5554/5555 on 2026-06-11 because an Android emulator
  (`gpteen_api34`) squats on 5554/5555 — see the emulator-port-conflict memory.
- **Production is unchanged:** the API container's internal port stays `5554`, pinned via `NESSIE_API_PORT` in `infrastructure/compose/docker-compose.prod.yml` (behind the shared Caddy proxy). Only local dev moved.

## Dev mode (hot reload)

- `pnpm dev` (repo root) = `turbo run dev --parallel`: API (nodemon) + admin
  (Vite HMR), on this worktree's resolved ports — 5454/5455 unless
  `NESSIE_API_PORT` / `NESSIE_ADMIN_PORT` say otherwise. Polling watchers are
  mandatory and must stay — see `AGENTS.md` → "Workflow" for why (fsevents is
  dead on this volume).
- After starting/restarting a dev server, verify it: hit `GET /health` on the
  API port and `GET /` on the admin port, and confirm `@vite/client` is present in the served
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
- `infrastructure/terraform/` and `.github/workflows/deploy-gcloud.yml` are the
  **planned** Cloud Run topology from Phase 4 of the horizontal-scaling plan,
  not the retired 2024 attempt and not production. Nothing has been applied and
  the workflow has no push trigger. Runbook:
  [docs/deployment/gcloud.md](docs/deployment/gcloud.md).

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **React hooks**: `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` run as errors over `admin/src`, `admin/test` and `packages/sign-in-surface/src`; a deliberate omission needs an `eslint-disable-next-line` with the reason beside it, never a silent one.
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
- Use Playwright (`mcp__plugin_playwright`, or a local Playwright script) to load `http://localhost:<admin port>/<path>` — 5455 unless this worktree set `NESSIE_ADMIN_PORT` — screenshot the affected page, and confirm the feature renders correctly.
- Always run Playwright headless unless the user explicitly requests otherwise.
- Executor pairing, live account-menu presence, and their browser verification are documented in [docs/executor-pairing.md](docs/executor-pairing.md) and [docs/executor-protocol/management.md](docs/executor-protocol/management.md).
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

**The codebase.**

- **API** (`api/`, default port 5454) — multi-tenant REST control plane: auth (OIDC/session), channels, tasks, approvals, triggers, MCP connector management, token ledger, audit log
- **Worker** (`worker/`) — async execution service: agentic loop, task scheduling, trigger delivery, mailbox processing
- **Admin** (`admin/`, default port 5455) — full product interface for operators and knowledge workers
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
- New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`;
  reusable concepts are re-implemented in `packages/`.
- Follow the architecture guardrails and anti-pattern list in `docs/architecture.md` before creating files, reorganizing code, or reusing logic.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
- **Agent voice, reactions and the working marker.** Agents answer at
  colleague length, react rather than reply when a message needs registering
  but no answer, and paint 👀 on the message a run is working from.
  Read [`docs/standards/agent-voice.md`](docs/standards/agent-voice.md)
  before writing code here.
- **Jev channel decisions.** Channel settings and the Personal Assistant share
  the enum policy; configured work carries its authorizer through queued runs.
  Read [`docs/standards/channel-decision-policy.md`](docs/standards/channel-decision-policy.md)
  before changing classification, policy editing or its execution.
- **A recurring watch keeps one rolling status message.** A sweep that finds
  nothing edits the watch's own status line in place instead of adding a
  message, so ninety-six quiet sweeps a day stay one line.
  Read [`docs/standards/rolling-watch-status.md`](docs/standards/rolling-watch-status.md)
  before writing code here.
- **Theming and the design system.** All colour lives in
  `admin/src/styles.css` as tokens; one tab bar, one identity tile, one
  composer, one dialog shell, no nesting, and a page a person passes *through*
  is painted in the menus' colour rather than the work surface's.
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
  Main response length is guided by the shared prompt, never an application
  token ceiling; provider protocol requirements and real budgets are documented there.
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
  label comparison, never a suffix test, or `evil-nessie.works` passes. On a
  tenant hostname the tenant is the brand, palette included, which is the one
  carve-out from "the sign-in screen is instance state". A team's certificate is
  issued on demand, gated by `/api/hosts/tls-check`, which verifies the
  **team** and not just its organisation because a certificate for a guessed
  label would burn the whole zone's weekly allowance — but an organisation
  still needs a line at the edge, because a `*.nessie.works` on-demand block
  breaks `api.nessie.works` and cost an outage to learn:
  read [docs/standards/team-hosts.md](docs/standards/team-hosts.md) before
  touching host routing, CORS, tenant branding, or the edge.
- **Automatic team access by verified email domain — Nessie holds the policy,
  UOA still authorizes every grant.** Every grant is a relay to `addTeamMember`
  carrying a fresh org-scoped subject assertion for the administrator who
  authorized the rule — never backend mode, never a local membership write; no
  call names a role and no path removes a membership.
  Read
  [docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md](docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md)
  before writing code here.
- **Paired agents (Nessie as an MCP server).** A paired credential names a
  human and can never reach more than they can; publishing is an approval, never
  a scope; and pairing itself is governed by the settings cascade and visible to
  an owner.
  Read [`docs/standards/paired-agents.md`](docs/standards/paired-agents.md)
  before writing code here.
- **Personal-assistant tools and route mirroring.** A PA tool that does what a
  person does by clicking calls the same function that person's button calls,
  and mirrors that route's authorization exactly. An ordinary agent reaches
  the setup verbs only through the explicit `project_operator` grant, on the
  live requester's own turn in a project channel it is in.
  Read [`docs/standards/personal-assistant-tools.md`](docs/standards/personal-assistant-tools.md)
  before writing code here.
- **Global agents, specialist delegation and `agent_handoff`.** App-provided
  agents are blueprints in code, one `systemManaged` row per organisation,
  reachable through a per-user single-agent DM.
  Read [`docs/standards/global-agents.md`](docs/standards/global-agents.md)
  before writing code here.
- **Project peer collaboration and ticket checklists.** Explicit project tool
  grants preserve the requesting person's access and the research disclosure
  basis; see [global agents](docs/standards/global-agents.md) and the
  [sales workflow verification](docs/testing/sales-agent-collaboration.md).
- **An approval is answered in the conversation it came from, and there is no
  list of them.** Every path that opens a request writes a card into a thread;
  a delegated run needs no special handling because a sub-agent run shares its
  parent's thread, and an approver who cannot see that conversation gets the
  card in their own Personal Assistant one. Read
  [`docs/approval-gating-spec.md`](docs/approval-gating-spec.md) → "Core rules"
  before adding an approval kind or a surface that lists them.
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
- **A board owns its tickets and its columns.** A project has many `Board`s,
  and `Task.boardId` says which one a ticket is on — `null` meaning the
  project's default board, which is where every writer that knows nothing about
  boards (agent runs, triggers, inbound mail, source sync) lands. One board's
  work never appears on another; `boardTaskPoolWhere` is the only place that
  decides. `Task.status` stays the single lifecycle truth and a board placement
  is a `TaskBoardPlacement` pin over it that is ignored once its column's
  category no longer matches. Placement is resolved server-side by
  `resolveBoardPlacement` (`@nessie/team-admin`) — never in the client — and
  board/column/field/source administration, plus iteration
  create/update/delete, is gated by `canModifyProject`
  (`requireProjectModifier` at the route): any member of the project, or an
  organisation owner or admin — the equal-rights rule in
  [docs/standards/team-model.md](docs/standards/team-model.md).
  Read [docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/overview.md](docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
  before writing code here.
- **Ticket comments, files and labels are one `@nessie/team-admin` function
  each, called alike by the route, the MCP tool and the worker builtin.**
  Bytes enter only through `POST /api/uploads` and are linked to a ticket,
  readable through the `taskId` arm of `canAccessAttachment`; removing a file
  is a mark (who, when, why), not a delete — it stays downloadable, has no
  restore, and a comment delete marks its files; a comment is its author's;
  labels belong to the ticket's home board (`Task.boardId ??` the project
  default) and follow a moved ticket by name; sync replaces only source-owned
  labels and never imports a narrower-audience comment.
  Read [`docs/standards/ticket-activity.md`](docs/standards/ticket-activity.md)
  before writing code here.
- **Ticket-driven agent work.** Only a board editor's own session-origin move
  starts a ticket's work, and only board editors' session-origin changes (plus
  a board source the trigger opts in) steer it; a `ticket.work` run acts as
  the agent with no effective user, the machine owner's authority is read
  only by the standing-policy binder, and teardown is the platform's, in the
  transaction that causes it.
  Read [`docs/standards/ticket-work.md`](docs/standards/ticket-work.md)
  before writing code here.
- **Document triggers.** Every canonical version write announces itself inside
  the save (`onVersionCreated`); a watched save opens one quiet window per
  (trigger, page), whose review carries metadata only — the agent reads the
  change through `kb_page_diff`'s gates — never wakes on the agent's own
  edits, reaches a ticket's live work only for the same agent, and pauses the
  trigger with a health reason when access to its space is lost.
  Read [`docs/standards/document-triggers.md`](docs/standards/document-triggers.md)
  before writing code here.
- **Provider reasoning ("thinking").** Every OpenAI-shaped stream is read
  for both reasoning spellings, the thinking switch is a per-dialect decision
  made at the transport boundary (DeepSeek `thinking`, DashScope
  `enable_thinking`, everyone else `reasoning_effort`), thinking is asked for
  only on a streamed non-JSON turn, and a turn's reasoning rides on its
  assistant message so DeepSeek's tool rounds get it back.
  Read [`docs/standards/inference-reasoning.md`](docs/standards/inference-reasoning.md)
  before writing code here.
- **Live document streaming.** Streaming taps the model's own tool-call
  arguments; the live lane never touches durable storage, and editing is deltas
  rather than a rewrite.
  Read [`docs/standards/live-document-streaming.md`](docs/standards/live-document-streaming.md)
  before writing code here.
- **Spreadsheets.** One write door under a per-page lock assigns the `seq` that
  is the only order; evaluation is paused around every apply; `toBytes()` is
  not byte-stable, so identity is the canonical projection and never the bytes;
  and an engine bump is a data migration, because two uncatchable Rust aborts
  make imports and large exports worker work.
  Read [`docs/standards/spreadsheets.md`](docs/standards/spreadsheets.md)
  before writing code here.
- **Executor-fronted local MCP servers.** `mcp.tools` and `mcp.call` are a
  transport onto servers the reviewed policy names, never a capability of their
  own; only a server's name travels, so its launch spec stays on the host and
  out of every message; availability rides the heartbeat rather than the signed
  descriptor, because installing the software must cost no revision; and absent
  never means empty, at any layer — a policy that names nothing permits nothing,
  and a Kelpie that could not look has not found nothing. The pair is the one
  bundle that carries across runs, and only into the launching person's own
  follow-ups under a conversation lease, each bound afresh. The built-in
  coding-sessions bridge acts as the machine's own user, so only a private
  executor's pairing owner may drive it.
  Read [`docs/standards/executor-local-mcp.md`](docs/standards/executor-local-mcp.md)
  before writing code here.
- **Local Ollama agents are owner-host-only and never fall back to cloud.**
  A user/team setting permits setup but grants no machine access; an exact
  native consent plus Agent Designer Save pins the model, and availability is
  a separate expiring agent lease. Read
  [`docs/standards/local-ollama-agents.md`](docs/standards/local-ollama-agents.md)
  before touching local discovery, bindings, host transport, presence or its
  user/executor surfaces.
- **Sequential task sets** use deterministic import, scheduling and output;
  native agent tools share the UI's authority, and configured Ollama search
  stays on the selected executor. Read
  [docs/standards/task-sets.md](docs/standards/task-sets.md) before changing them.
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
  Chat review pointers and draft handoffs stay content-free until the same
  viewer-scoped Mail surface authorizes their live read or edit.
  Read [`docs/standards/connected-mailboxes.md`](docs/standards/connected-mailboxes.md)
  before writing code here.
- User-authored MCP connectors may use HTTP/SSE remote endpoints only. Cloud-side stdio process execution is disabled at catalog, instance, dispatch, and worker boundaries; HTTP/SSE/OAuth URLs must pass the SSRF guard. Use remote MCP runners for private networks or local machines.
- **Model availability — the owner decides, and the decision is real.** The
  Models page lists Ledger's live catalogue left-joined to the organisation's
  own rows, an absent row means available, and a row it writes is a container
  that can never redirect a run. A disable is enforced at the picker *and* at
  the one write-time validator; an agent already pinned keeps working, and every
  surface says so.
  Read [`docs/standards/inference-model-availability.md`](docs/standards/inference-model-availability.md)
  before writing code here.
- **Outbound egress is IP-pinned, not just validated.** Anything reaching a
  caller-, operator- or model-supplied address goes through `@nessie/runtime`
  `safeFetch`/`pinnedFetch` (raw sockets through `resolveVettedAddresses`);
  the root `eslint.config.js` egress block bans global `fetch` as the ratchet.
  Read [`docs/standards/egress.md`](docs/standards/egress.md)
  before writing code that dials out.
- **Nothing a second instance cannot see.** The API and the worker run as N
  replicas: no module-scope mutable state, every periodic job claims its work
  or takes `withSweepLock`, every run is fenced and resumable, `SIGTERM` drains
  inside sixty seconds, and realtime publishes under a per-scope advisory lock
  held across insert and commit, so id order is commit order;
  the horizontal-scaling block in the root `eslint.config.js` is the ratchet.
  Read [`docs/standards/horizontal-scaling/overview.md`](docs/standards/horizontal-scaling/overview.md)
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
  through Ledger; every research is agreed as a brief with DeepWater's planner
  first and comes back to the conversation it came from, and the brief, grant
  bundle and legacy handoff rules are exacting. Ledger relays nothing back:
  DeepWater pushes progress, settled turns and outcomes straight to a signed
  receiver, and each turn or outcome only triggers the read the worker's
  `deep-water-watch` backstop makes as the requester, which delivers a finished
  research exactly once, under its research card with an explicit-recipient
  alert to the person who asked, or as one run that wakes the agent that
  asked; progress streams to the card and never wakes anyone. Its `report.md`
  and `sources.csv` are served only
  behind the run's viewer predicate, and a person's brief is theirs alone until
  it is launched.
  Read [`docs/standards/deepwater.md`](docs/standards/deepwater.md)
  before writing code here.
- **Customer billing stays in UOA.** Tariffs, statements, credits, top-ups,
  subscriptions and Stripe lifecycle are authoritative in UOA; Nessie renders
  UOA-authored display models and stores no commercial state.
  Read [`docs/standards/customer-billing.md`](docs/standards/customer-billing.md)
  before writing code here.
- **Builtin `web_search` is Ledger-only, and Ledger picks the engine.** Every
  call posts to Ledger with signed provenance — the multi-provider Purpose API
  route when one is configured, else the single Serper route — so adding
  SerpAPI or Brave is a Ledger route change, not a Nessie deploy; `present`
  posts the page as a search card whose pager is a human search door.
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

## DeepTest native adapters — local source and scoped execution

DeepTest may read one locally approved workspace and, under a separate grant,
validate in its disposable copy through packaged child-process adapters;
source and results never use Nessie's hosted command path. DeepTest retains
separate inference and per-run active-testing approvals.
Read [`docs/standards/deeptest-native-adapter.md`](docs/standards/deeptest-native-adapter.md)
before changing this boundary.

## Agent documents — required core, one shared home

Every ordinary agent has canonical `AGENTS.md` and `personality.md` versions
in its one `@nessie/knowledge` home; run admission pins and authorizes them,
while the remaining files stay available through the ordinary read tools.
Read [`docs/standards/agent-documents.md`](docs/standards/agent-documents.md)
before writing code here.

## Cloud browsers — a second transport, not a second browser surface

Agents drive a real Chromium in the cloud (Browserbase) as well as the one the executor runs on a person's machine (phase 1 shipped 2026-09-02). The browser verbs are the executor's own closed grammar reused verbatim under their own `requiresExplicitGrant` key; connection scope follows the surface that accepted the key; and because browser-hours are money, release is fused to `updateRunStatus` while a reaper stops strays by calling Browserbase. Those invariants, their rationale and the as-built deltas (§5a) live in [docs/plans/2026-09-02-browserbase-cloud-browsers.md](docs/plans/2026-09-02-browserbase-cloud-browsers.md) — read it before touching this.

Private browser access, human control, selected-site Chrome import, and their
explicit grants are a separate contract: read
[docs/plans/2026-09-07-private-browser-access-and-import.md](docs/plans/2026-09-07-private-browser-access-and-import.md)
before touching those surfaces.

## Conversational Agent Designer access

The Designer acts only with the live requesting member's authority. Generic
agent updates must continue to reject protected keys; protected builtins and
MCP tools use their specialist grant service, and DeepWater remains an atomic
bundle whose revocation waits for that agent's unlaunched briefs and any open
launcher run. Read
[docs/plans/2026-09-20-agent-designer-capabilities-and-output-recovery.md](docs/plans/2026-09-20-agent-designer-capabilities-and-output-recovery.md)
before changing these contracts.

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
client-only liveness hint are part of the same standard. A container `Thread`
with an `agent_id` is a **conversation with that agent** — one agent, many
isolated contexts in the same room — and a top-level `user` turn inside one
addresses it structurally, never by a content judgement.
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

- Executor terminal sessions use tmux on Mac/Linux and ConPTY on Windows; read [the session guide](docs/executor-protocol/terminal-sessions.md) for setup, sharing, agent tools and native verification.
