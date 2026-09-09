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
| [10](architecture.md#10-model-judged-memory-extraction) | Semantic memory works across languages | Terra; Sol if inference integration expands | Coordinate with memory/recall PR 434 |
| [11](architecture.md#11-complete-uoa-authority-and-hierarchy) | UOA owns identity and hierarchy without durable copies | Sol | Audited migration; staged rollout |
| [12](architecture.md#12-deploy-only-the-verified-commit) | Deployment uses a verified merged commit | Terra | Add required check after a successful run exists |

## Execution order

1. Start the coupled run-lifecycle items 1/2 with Sol and scheduled retries
   with Terra. Each owns a separate worktree and PR.
2. Run the product track 5, 7 and 8 in one agent's sequential worktrees, then
   6 on the merged task-navigation contract. These remain coherent PRs rather
   than concurrent edits to `ProjectView`.
3. Dispatch 4, 9, 10 and 12 as capacity frees. Scope each worktree to one item.
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

Planning and initial implementation dispatch are in progress. Items 1/2 and 3
are assigned. The other items are queued in the order above. A second review
for ten additional findings runs independently and does not expand this scope.
