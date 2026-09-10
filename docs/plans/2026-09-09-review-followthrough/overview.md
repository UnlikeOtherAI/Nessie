# Review follow-through — twelve implementation plans

Approved on 9 September 2026 after the review of `a3b144e9a`. This is the
delivery plan for the twelve findings, not a claim that the changes are shipped.
Additional review findings are a separate backlog until assigned.

## Table of Contents

- [Runtime reliability](runtime.md) — items 1–4.
- [Product workflows](product.md) — items 5–9.
- [Architecture and releases](architecture.md) — items 10–12.

## Plans and owners

| Item | Outcome | Agent model | Dependency |
| --- | --- | --- | --- |
| [1](runtime.md#1-recover-retryable-runs) | A retry can reclaim its run immediately | Sol | None |
| [2](runtime.md#2-commit-success-once) | Completed work cannot become a failed answer | Sol | Same lifecycle owner as 1 |
| [3](runtime.md#3-one-retry-owner-per-scheduled-occurrence) | One scheduled occurrence produces one dispatch | Terra | None |
| [4](runtime.md#4-bounded-authorized-agent-history) | History pages have bounded database work | Terra | Coordinate with conversation PR 436 |
| [5](product.md#5-open-the-ticket-presented-in-chat) | Ticket links open the exact task | Terra | Before 6 |
| [6](product.md#6-tickets-in-human-search) | Search finds accessible native and mirrored tickets | Terra | 5 |
| [7](product.md#7-project-administration-permissions) | Project controls reflect effective permissions | Terra | Coordinate edits with 5 and 8 |
| [8](product.md#8-explicit-project-load-failures) | Load failures offer recovery, not false empty states | Terra | Coordinate edits with 5 and 7 |
| [9](product.md#9-browser-push-tenant-ownership) | Browser subscriptions work across organizations | Terra | Serialize migrations with 11 |
| [10](architecture.md#10-model-judged-memory-extraction) | Semantic memory works across languages | Sol | Coordinate with memory/recall PR 434 |
| [11](architecture.md#11-complete-uoa-authority-and-hierarchy) | UOA owns identity and hierarchy without durable copies | Sol | Audited migration; staged rollout |
| [12](architecture.md#12-deploy-only-the-verified-commit) | Deployment uses a verified merged commit | Terra | Add required check after a successful run exists |

## Execution order

1. Start the coupled run-lifecycle items 1/2 with Sol and scheduled retries
   with Terra. Each owns a separate worktree and PR.
2. Run the product track 5, 7 and 8 in one agent's sequential worktrees, then
   6 on the merged task-navigation contract. These remain coherent PRs rather
   than concurrent edits to `ProjectView`.
3. Dispatch 4, then 12 ahead of 9 so deployment gating protects subsequent
   merges. Give 10 to Sol after the run-lifecycle work because it spans utility
   inference, billing and disclosure. Scope each worktree to one item.
4. Give 11 to Sol for an API capability inventory and migration decomposition,
   then execute the verified slices. Do not retain new compatibility mirrors.
5. The coordinator reviews evidence, handles integration conflicts, waits for
   required CI, merges green PRs and removes their worktrees and branches.

## Definition of done

- Reproduce each defect through its actual boundary before relying on a fix.
- Tests assert user outcomes, authorization and retry behavior; avoid tests
  that merely match source text or mirror implementation branches.
- Package tests use Turbo with an exported, dedicated `DATABASE_URL`. Global
  poller suites have an exclusive database. Prisma generation and builds are
  serialized inside each worktree; worker changes rebuild worker `dist`.
- All frontend work has headless Playwright evidence at `localhost:5455`, with
  the API on 5454. One agent at a time owns these ports; verify health after
  every start. Retain durable evaluations in the appropriate existing suite.
- Follow disclosure, UOA authority, navigation and shared-surface invariants.
  No external messages or real provider effects are needed for these tests.
- Update the affected standards, contracts and known-limitations entries in
  the implementation PR. Record any unavailable verification explicitly.
- Immediately push every commit. Every change lands through a green PR;
  nothing pushes directly to `main`. The coordinator owns final merges so
  agents cannot race shared integration or branch-protection changes.

## Status

The plans landed in [PR 438](https://github.com/UnlikeOtherAI/Nessie/pull/438).
Implementation status on 10 September 2026:

- **1/2 — Sol:** fenced run handback is committed; atomic completion and
  durable follow-up delivery are in progress in the same lifecycle branch.
- **3 — Terra:** [PR 440](https://github.com/UnlikeOtherAI/Nessie/pull/440)
  landed as `688859ed3` after all nine CI checks passed. Scheduled retries now
  retain one occurrence owner, and an explicit pause cancels pending retries.
- **4 — Terra:** cursor pagination and batched disclosure are implemented and
  being verified. Indexed retrieval is bounded per distinct run conversation;
  its remaining cost scales with the number of conversations, not messages.
- **5 — Terra:** [PR 442](https://github.com/UnlikeOtherAI/Nessie/pull/442)
  landed as `31811ff51` after all nine CI checks passed. Chat cards and cold
  links open the exact task in the shared dialog with its current placement.
- **6/7/8/9 — Terra:** queued; the project-permissions worktree is prepared.
- **10 — Sol:** queued after run-lifecycle verification.
- **11 — Sol:** the UOA capability inventory is complete; a first live-directory
  slice and the audited migration plan are being verified. Full authority
  removal remains dependent on upstream contracts and the hierarchy audit.
- **12 — Terra/coordinator:** Multi-Instance Smoke is now required on `main`.
  The exact verified-SHA deployment gate is next after history pagination.

The [ten additional findings](../../reviews/2026-09-09-additional-ten.md)
landed in [PR 439](https://github.com/UnlikeOtherAI/Nessie/pull/439). They remain
a separate review backlog and do not expand the approved implementation scope.
