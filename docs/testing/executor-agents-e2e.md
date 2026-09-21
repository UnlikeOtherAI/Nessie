# Executor agent management evaluation

The executor detail page's Agents tab uses `ExecutorAgentsPanel`. Its Add agent
dialog reads eligible candidates from the server, then opens the existing access
change review. Preparing or cancelling a change does not grant or remove access.
The server remains the authority for visibility, eligibility and verification.

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

Desktop and phone cases cover opaque cursor pagination, server search, page-size
changes, private assignment gaps, exact capability labels, candidate selection,
the prepare/review/confirm and cancel paths, removal, and load-error retry.
An unavailable identity verifier must display an explanation with no password
field and no enabled approval action. Screenshots are written to
`e2e/screenshots/executor-agents/` and should be visually inspected.

The review names the Personal Assistant through the same entitled `scope=all`
agent directory used by candidate eligibility. A disappeared identity keeps
approval disabled, and agent changes never request the people directory.

This fixture proves the UI flow. The executor management database and HTTP
tests prove entitlement filtering, private roster changes, grant atomicity,
and fresh verification enforcement. It does not exercise a real UOA verifier;
that contract remains unavailable and the product refuses protected changes.
