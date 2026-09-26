# Test a CTO locally with a real personal provider

Use the local API, its embedded worker, the Vite UI and a separately paired
executor connection. No deployment is needed to test a worker change.

## Prepare and run

Use a task worktree. Keep the database in the shared local Postgres container
and executor state outside all checkouts, following
[local state](../standards/local-state.md). Use a dedicated database for this
live scenario; never run global-poller tests against it while the API is running.

Install with `pnpm install --frozen-lockfile`, generate Prisma, apply migrations,
then build the API, worker, executor and UI workspace dependencies through Turbo.
Build `@nessie/client-core` and `@nessie/sign-in-surface`, not the admin bundle.
Set the worktree's fixed ports, `NESSIE_MODE=local`, database URL and a random
local authentication secret. Start `pnpm dev`. Verify `/api/health` returns 200
and the admin HTML includes `@vite/client`.

For real personal-model calls without a development vault, explicitly set
`NESSIE_LOCAL_SUBSCRIPTIONS_MEMORY=1` before starting. The API and embedded
worker share an in-memory credential store; production still requires its vault.
Link the key through **Connected accounts**, then select that exact connection
when creating a fresh private CTO. Credentials are lost on server restart:
relink the same account before the next run. Do not put a provider key in Git,
a chat prompt, a fixture or a log. No deployment model is used as a fallback
for this CTO's inference. Avatar generation and memory extraction still use
the separately configured deployment model.

Pair an additional connection using a separate owner-only executor state
directory and the local API origin. Do not replace a production connection or
copy its machine key. Configure an actually installed terminal executable,
assign the CTO through the normal machine Agents surface or its API. Pairing
establishes the connection; current capability reports and agent assignments
require no second password/code or separate machine-permission approval.
The native account-management flow remains separate from this CLI test setup.

Rebuild the worker after changing worker source; the API watches its output.
Relink the temporary provider connection after that API restart. Use a new
conversation for an acceptance test so earlier failures do not prime the model.

## Acceptance evidence — Windows, 2026-09-25

A fresh private CTO used a linked personal Kimi account against a local API
and embedded worker. A Windows executor connected locally while the existing
production connection on the same machine remained online with its own key.

The first attempt failed because the test setup named an absent PowerShell 7
executable. Correcting the reviewed local configuration to the installed
Windows PowerShell executable resolved it without a deployment.

The next clean conversation completed without a reminder: one
`terminal_session_start`, one initial read, one command write, one Enter write,
one result read and one `coding_session_close`. The only OS command was:

```powershell
Get-Volume | Select-Object DriveLetter, FileSystemLabel, Size, SizeRemaining | ConvertTo-Json
```

The reply showed measured total/free bytes for C:, D: and the letterless
volume. The session state subsequently became `closed` with no process
identity. Both executor connections remained online. The reply was inspected
in the local browser. This verifies Windows and two concurrent connections;
it does not by itself verify the other platforms or native multi-account UI.

## Continued work acceptance — 2026-09-25

Three further tasks ran through the same personal Kimi connection locally:

- Sales reconciliation: read a CSV, excluded cancelled/refunded orders, wrote
  and independently reconciled a report: six paid orders, 13 units, 206.90 revenue.
- Invoice repair: ran the supplied seven tests (five failed), repaired the
  calculation without editing tests, and reran successfully (seven passed).
  An independent rerun also passed; the example total was 4,858 cents.
- Delayed report: launched an 18-second job once, followed it to completion,
  read its manifest and checked all three source-file hashes and byte lengths.
  Independent verification matched the artifact. Chat output masked hashes
  through existing output redaction; it did not expose complete hashes.

All three streamed an acknowledgement before the first tool call and ended
with a final chat answer and a closed terminal. Streamed progress is distinct
from the one durable final message. No test reminder remained pending.
The run exposed and fixed a terminal loop detector that counted Enter across
different commands: the repeated-input limit now applies since the last
different input in that same session, including across checkpoints.

## Three-machine and multi-connection acceptance — 2026-09-25

New CLI connections on macOS and Ubuntu used the default pairing flow and
received separate machine identities alongside their existing production
connections. Each was approved once and granted to the local CTO. All three
machines were available concurrently. Three fresh CTO conversations used the
same personal Kimi subscription and completed a read-only OS, CPU, RAM and
mounted-filesystem inventory: Windows through PowerShell, Ubuntu through bash,
and macOS through its installed Claude Code. Each streamed an acknowledgement
before its first tool call, returned the measured inventory and closed its
session. Existing output sanitization masks hostnames and some mount paths;
the CTO explicitly reported that limitation on Mac and Linux.

Local checks also passed: Windows service (56 tests), tray (41 tests),
Windows Desktop Rust compilation, Mac app source typecheck and all 92 Mac
core XCTest cases. The executor Turbo suite passed on Node 22.23.3: 517 tests
in the ordinary pass plus 95 in the native-helper pass; platform-dependent
skips remain. Its concurrency is bounded to avoid saturating Windows.
The full repository lint and the admin/executor typechecks passed.

Headless Playwright verified the real Windows tray renderer with two
simultaneous connections and a service refresh while Add account was open.
It also verified the shared Desktop pairing dialog at 1280px and 390px,
including Windows and Linux native-transport fixtures. Native folder and
confirmation dialogs were mocked in those browser checks. Linux native
bundling passed CI. The Mac GUI was not installed: this machine has no
Developer ID Application certificate, so its current signed app remains intact.

Installer verification must run the full Mac build, not only `swiftc -typecheck`:
the Release compiler also checks definite initialization of property wrappers.
That build caught an account-controller initializer reading a `@Published`
property before all stored properties were initialized. Constructing the initial
controllers in a local value before assigning either published property fixes it.

## Ordinary chat across three machines — 2026-09-26

A fresh private CTO used the owner's personal Kimi connection through a normal
conversation message, without an executor-run launch or conversation lease.
The run bound all three assigned, online machines and returned measured disk
space after one OS query per machine: PowerShell `Get-Volume` on Windows and
`df -h` on Ubuntu and Mac (the Mac test connection used Claude Code).
All three session files then reported `closed` with no process identity.
No additional approval or code was requested.

This covers the ordinary-chat route that the earlier explicit-launch tests
missed. The model corrected an invalid optional folder path before executing
the commands. Initial fixture startup also exposed stale local capability and
connection state; reconnecting the existing test connections resolved that
before the successful run. Production connections were left running.

Document-link verification exposed guessed arguments when the new link tool
was deferred. Its small schema now stays inline, argument mistakes are
correctable, and knowledge listings/search/reads return canonical links.
A clean repeat completed with one `kb_list` call and a named, clickable home-space
link, with no raw identifiers in the visible reply.
A subsequent ordinary Mac-only follow-up ran one `df -h /`, reported the
measured free space, closed its session and included the named machine link.
The other two computers received no commands for that follow-up.
An explicit link-tool request then completed with one successful `nessie_link`
call and a named Mac link, without a schema-discovery call or visible GUID.

Production verification on the same date repeated the ordinary three-machine
request using the owner's actual personal Kimi connection. It returned a disk
table with named machine links, closed all sessions and left no reminder pending.
The first Linux terminal exited at its folder prompt; the CTO opened a replacement
and completed the query. An earlier Mac startup failed transiently; both its
single-machine retry and the final combined run succeeded without installation
changes. The document answer also used named space/file links, and opening the
AGENTS.md link reached the correct document.

The scheduled-follow-up regression ran locally with the same real personal Kimi
connection. The CTO set `check_back_in` and finished its first turn. Advancing
only that disposable test reminder's due time let the normal scheduler wake it:
the new agent-identity run retained the Windows machine, executed the requested
`Get-Volume` query once, returned the measured volumes and closed its session.
Both turns completed without another user message; the session file confirmed
`closed`. Database tests additionally cover three-machine/chained reminders,
delivery-time checks, changed audiences, revoked access and cancelled source runs.
