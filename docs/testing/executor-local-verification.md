# Local Windows executor verification

Checked on 2026-09-07 from the `test/executor-test-environment` worktree.

## Available local stack

- API port 5454 is listening and `GET /api/health` returns 200.
- Admin port 5455 is listening and `GET /` returns 200 with `@vite/client`.
- Both processes run from the `rich-assignees` worktree. Do not restart them
  from an executor verification worktree.
- The local API environment supplies database configuration. It must be loaded
  into a test subprocess without printing its values.
- Docker is available, and the host has the Windows Hyper-V management service.
- Codex and Claude CLIs are installed. The current executor coding profile only
  implements the Codex guest session; Claude is not a supported executor coding
  profile yet.

## Executor state

- The installed Nessie Desktop app is unsigned version 0.1.0.
- No standalone Nessie Executor MSI, Windows service, tray process, or
  `nessie-executor` command is installed.
- The authenticated local Executors page renders an empty list and its Pair
  executor form. It initially showed a Vite cold-load skeleton and recovered on
  reload; no API error was established.
- Pairing must create an executor through the authenticated surface, complete
  the signed daemon enrollment, and then be confirmed by the user. Do not create
  a local UOA identity record or grant an existing watcher agent for this test.

## Test-harness readiness

- `pnpm install --frozen-lockfile` completed in this worktree. Its generated
  `node_modules` is untracked setup state.
- The normal executor test command initially could not resolve workspace
  packages because this worktree had no dependency links.
- The first package build found an out-of-date generated Prisma client. The
  documented single `pnpm prisma:generate` step fixed that; `@nessie/runtime`
  and `@nessie/executor-manage` now build successfully.
- A focused coding-session test fails on this Windows source setup and leaves
  the manager's twenty-minute stop timer live after the assertion, so the test
  process must be interrupted. Treat it as a fixture/lifecycle test issue until
  rerun with a clean failure report; it does not establish a pairing failure.
- The real worker smoke harness supports the shared local development database.
  It uses a deterministic mock LLM and cleans its own seeded scope. The
  multi-instance smoke requires a separate freshly migrated database and must
  not use the active development database.

## Real-path verification sequence

1. Create a dedicated non-system agent for executor verification through the
   normal authenticated product flow.
2. Pair a Windows executor with that exact agent and a private or project scope.
3. Approve the descriptor and grant only `coding.launch`, `coding.observe`,
   `workspace.review`, and `workspace.promote` after fresh verification.
4. Start the daemon and prove online liveness through the API before launching a
   run.
5. Launch a coding run that requests the pre-granted bundle; verify its
   encrypted command/result lifecycle and workspace review. A human must still
   explicitly confirm any workspace promotion.

## Current product gap

Assigning an agent to a board task writes a task event and human attention only.
It does not create a run, executor binding, or coding session. Board watcher
wakes do create a run, but likewise have no executor binding. The smallest
implementation should introduce an explicitly configured, entitlement-checked
task-to-executor policy that creates the exact run-scoped coding binding in the
same transaction as the assignment wake. It must retain the existing opaque
candidate resolution, descriptor/local-policy checks, operation grants, and
review-before-promotion boundary.
