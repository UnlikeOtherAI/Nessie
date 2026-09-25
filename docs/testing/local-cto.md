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
approve its descriptor once and grant the CTO access through the normal API/UI.
Adding that agent within the approved boundary requires no second password/code.
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
it does not claim a three-platform test or a finished native multi-account UI.
