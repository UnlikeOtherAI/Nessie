# Executor agent management evaluation

The executor detail page's Agents tab uses `ExecutorAgentsPanel`. Its Add agent
dialog reads eligible candidates from the server and assigns the selected agent
immediately. Remove is immediate too. The server owns visibility and eligibility.

Run the durable browser evaluation from a worktree with its own available ports:

```sh
NESSIE_API_PORT=5844 NESSIE_ADMIN_PORT=5845 node admin/e2e/executor-agents/run.mjs
```

Install dependencies and build `@nessie/schemas` and `@nessie/client-core` first.
The evaluation starts and verifies its own Vite development server, refuses to
adopt an occupied port, and shuts that process down afterward. It uses the
navigation harness's `CHROMIUM_PATH` setting when Chromium is not downloaded.
No API process or database is needed: browser requests receive deterministic
responses while the real components and facades run unchanged.

Desktop and phone cases cover pagination, server search, page-size changes,
capability labels, direct addition/removal, Personal Assistant eligibility and
load-error retry. Admin mutations create no review continuation or password
prompt. A separately opened conversation card retains its confirmation flow.
Screenshots are written to `e2e/screenshots/executor-agents/` and inspected.

Database tests cover entitlement, roster/grant atomicity and revocation.
See [executor sharing](../standards/executor-sharing.md) for the current contract.
