# Local Windows executor verification

Checked on 2026-09-07 from the `test/executor-test-environment` worktree.

## Available local stack

- An earlier shared API/admin loop reached 5454/5455, but its temporary
  environment and processes had ended before this verification completed.
- The dedicated `nessie-project-usability-db` container at loopback port 54329
  is reachable and its pending migrations applied successfully. It is the
  isolated no-IdP fixture database used for this work.
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
- A private executor was created through that authenticated local form without
  an agent assignment. Its source pairing must target `http://127.0.0.1:5454`.
  The form instead prints the production API when Vite uses a same-origin API
  base: `ExecutorsPage` falls back to `https://api.nessie.works`. This is a
  local invitation rendering bug, not an API public-url setting.
- The source pair command was not launched here: the command-execution policy
  rejected the enrollment workflow even with `--challenge-stdin`. The
  one-time challenge has not been written to this worktree or sent to another
  endpoint. Complete that source pairing from an authorized local terminal.
- Pairing must create an executor through the authenticated surface, complete
  the signed daemon enrollment, and then be confirmed by the user. Do not create
  a local UOA identity record or grant an existing watcher agent for this test.

## Fixture UI attempt

- Root-level `pnpm exec vite` and `pnpm exec tsx` are available. The retained
  `rich-assignees` directory also has the built worker and
  `@nessie/model-subscriptions` artifacts needed for its API.
- The fixed worktree's API cannot start directly because its
  `@nessie/model-subscriptions/dist/index.js` artifact is absent. The retained
  API was prepared to run against the isolated fixture database while the fixed
  worktree supplied the admin server.
- The required hidden background launch was rejected by the automatic command
  execution policy as `blocked by policy` before it ran. It was not retried by
  another shell or route. Therefore no authenticated browser UI proof exists
  for the corrected invitation, even though focused regression coverage and CI
  cover its rendering contract.

## Test-harness readiness

- `pnpm install --frozen-lockfile` completed in this worktree. Its generated
  `node_modules` is untracked setup state.
- The normal executor test command initially could not resolve workspace
  packages because this worktree had no dependency links.
- The first package build found an out-of-date generated Prisma client. The
  documented single `pnpm prisma:generate` step fixed that; `@nessie/runtime`
  and `@nessie/executor-manage` now build successfully.
- `node --test --test-force-exit --import tsx --test-reporter spec
  test/coding-session-manager.test.ts` ran zero subtests because
  `executor/src/egress-gateway.ts` could not import the missing
  `@nessie/runtime/dist/url-safety.js` artifact. This is a worktree build
  prerequisite failure, not pairing or coding-session behavior; the old
  unregistered tree no longer contains the original assertion source.
- The real worker smoke harness supports the shared local development database.
  It uses a deterministic mock LLM and cleans its own seeded scope. The
  multi-instance smoke requires a separate freshly migrated database and must
  not use the active development database.

## Discovered versus executed coverage

| Capability | Status |
| --- | --- |
| Folder canonical root and COW drafts | Exists; not live-tested. |
| Codex guest session | Exists; not live-proven. |
| Claude guest session | Unsupported. |
| Browser guest session | Exists; an existing-user `connected_browser` is intentionally withheld and has no bridge. |
| Per-agent persistent allow/deny | Exists. |
| Local deny, allow once, and always allow consent | Not fully proven. |
| Board assignment to executor and green-PR orchestration | Absent. |

The current [executor protocol](../../executor/src/index.ts) and
[Windows desktop guide](../running-the-apps/windows-desktop.md) remain the
authoritative implementation and operator references.

## Real-path verification sequence

1. Create a dedicated non-system agent for executor verification through the
   normal authenticated product flow.
2. Pair a Windows executor with that exact agent and a private or project scope.
3. Approve the descriptor and grant only `coding.launch`, `coding.observe`,
   `workspace.review`, and `sandbox.stop` after fresh verification.
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

A coding run is also blocked until Ledger has a catalog entry for the executor
coding profile.
