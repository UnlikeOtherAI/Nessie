# Local Windows executor verification

## Standalone Windows service verification — 2026-09-17

A debug standalone MSI built from the pre-fix `main` source installed
successfully and registered `NessieExecutor` as an automatic service running as
`NT SERVICE\NessieExecutor`; its tray also remained running without opening a
window. The service did **not** supervise an executor: Windows Installer had
created `%ProgramData%\Nessie Executor` as SYSTEM with inherited permissions,
and the service log reported
`EXECUTOR_STATE_SECURITY_IO_FAILURE` when its service-account process tried to
replace that boundary. This is live failure evidence, not release evidence.

The corrected implementation moves the initial owner-only DACL setup into an
elevated, packaged native-helper custom action before the service starts. The
tray's elevated workspace grant now asks the service over the locally
ACL-gated pipe to record the caller SID from an authenticated administrator token;
it does not write the protected service tree. Native tests exercise the exact
pipe access mask, repeated listener creation, caller-derived enrollment, and
the refusal path. Recovery tests use real child processes to prove
connect, daemon start, crash observation, backoff, Stop and service shutdown.
The real tray HTML was rendered headlessly with a `starting` executor: the
attention state appeared, Start was disabled, Stop was enabled and dispatched
the expected executor id.

A corrected `0.0.2` debug MSI was then installed over that baseline. The
`NessieExecutor` service remained `Running` and `Auto` under
`NT SERVICE\NessieExecutor`; the installer action completed, the service's
owner-only verification passed, and an ordinary user could no longer read the
state ACL or log. An elevated workspace grant recorded the
user, and the same ordinary user completed three consecutive exact-rights
`status` pipe exchanges without stopping the service. That live run exposed one
remaining client-framing defect: the tray received a valid newline-delimited
answer but read through the server disconnect and reported `the service closed
the connection`. The subsequent fix changed the tray to read one bounded,
newline-framed response and added a real server-write-and-disconnect regression
test.

The next corrected debug package, `0.0.3` (SHA-256
`a0eb0b6559fa66625c4814bde499657c9eaae4e67c704e8c33e4e28095073e63`),
included that reader fix. Its hash verified and the MSI installed successfully.
The service ran automatically as `NT SERVICE\NessieExecutor`; the installed
tray's elevated workspace grant exited zero with no error output, granted the
service read access while preserving the fixture owner and other ACLs, and the
ordinary account completed three status exchanges. The installed tray then ran
headlessly for ten seconds, responded without a main window, and its exit left
the service at the same process id. Two more ordinary status exchanges passed;
the tray relaunched successfully, and its per-user Run entry named the installed
executable. The service ran in Windows Session 0 while the relaunched tray ran
in interactive Session 1, directly proving that supervision did not depend on
the tray process or its login session. Reboot and logoff recovery were not
performed. The executor list remained empty because no pairing was created.

A final debug package, `0.0.4` (SHA-256
`53942cef6ffd358193949c9c839a633ab87b20523e0564dce0ff6a5ccd985d1d`),
added packaged Windows artifact provenance and the GUI subsystem flag to the
same tested service/tray implementation. Its hash verified and the MSI installed
successfully. The automatic service ran as `NT SERVICE\NessieExecutor` in
Session 0, while the installed GUI-subsystem tray ran responsively in Session 1
without a console or main window. The official elevated workspace grant exited
zero with empty stderr, preserved the fixture owner's ACLs, and granted the
service only Read and Synchronize. Six ordinary exact-rights status exchanges
passed, three before and three after the grant.

The installed package's Node and native helper passed the focused browser
configuration/session tests (9), guest runtime snapshot/session tests (3),
installed-resource provenance tests (2), and the state save/load and protected
pairing-root assertions (2). One read-only workspace symlink test explicitly
skipped because the unelevated Windows test process could not create a file
symlink; the directory-junction fail-closed test passed. The broader
`index.test.ts` harness leaves `process.exitCode` set after exercising CLI usage,
so its two selected state assertions passed while the file-level harness still
returned exit 1; this is not counted as a green file suite.

Windows guest execution remains blocked beyond the verified utility and
transport scope. The production Hyper-V backend still resolves its guest disk
builder through Linux-only `mkfs.ext4` locations, and its guest gateway path
uses POSIX socket-directory checks. No sandbox/browser/coding guest action was
claimed or performed.

The focused native and renderer checks above are not a whole-repository pass.
The local Turbo executor suite was attempted after building its workspace
dependencies. Its earlier Windows owner/private-artifact failures led to the
packaged-resource and DACL fixes above, but that full run later stopped producing
output and was interrupted rather than reported green. The
repository's older pairing renderer harness also failed before its pairing
assertion because it did not choose the workspace that the current form
requires. The dedicated starting-state renderer used for this verification is
separate and passed.

A live pairing to `https://api.nessie.works` still requires the normal
authenticated Executors surface and human fingerprint confirmation. It has not
yet been performed and is not implied by the native, installer, pipe, or
renderer evidence above.

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
