# Executor-fronted local MCP servers

A paired executor can front MCP servers installed on its own host and reachable
from nowhere else — a browser automation server bound to loopback, a tool that
drives hardware on that desk. Nessie never speaks to those servers. It names one
in the reviewed local policy, and the daemon proxies exactly two operations to
it.

The first such server is [Kelpie](https://github.com/UnlikeOtherAI/kelpie), an
LLM-first browser whose CLI exposes 145 MCP tools across every Kelpie instance
it can find.

## The two operations are a transport, not a capability

`mcp.tools` lists a named server's tool catalog. `mcp.call` invokes one tool on
it. What the pair can *do* is whatever the named server's own tools do, which is
why the policy names servers rather than granting a blanket "run local MCP".

They form their own run bundle (`mcp.tools` + `mcp.call`, exactly), exclusive of
the browser, connected-browser, coding and command bundles. One run, one kind of
reach.

`mcp.call` passes the tool's `arguments` through **untouched**. That grammar
belongs to the server, and validating it here would guarantee drift the first
time the server ships a field — the daemon validates the envelope, never the
payload.

### Reserved `_meta` is for the built-in bridges alone

The model reaches `arguments` and nothing else. A built-in bridge that must
know *who* is calling reads reserved keys from the request's `_meta` instead,
which only the daemon sets and only on calls to that bridge:

| Key | Carries | Used for |
| --- | --- | --- |
| `nessie/owner` | `sha256:` + hex SHA-256 of executor id, agent id and actor user id joined by `\|` | isolating one owner's coding sessions from another's |
| `nessie/command` | the executor command id | making a replayed or retried call a no-op that returns the first outcome |
| `nessie/daemon-control` | `true` on the daemon's own teardown and report calls | `session_close_all` and `session_list_all`, refused without it |

The owner comes from the `mcp.call` **payload**, not from the model:
`ExecutorMcpCallPayloadSchema` is `{args, runId, owner?}`, strict, and the
worker stamps `owner: {agentId, actorUserId}` from the binding's candidate
beside `runId`, so the argument digest covers it and an `owner` inside
`args` is refused as malformed. `executorCodingSessionOwnerKeyInput` in
`@nessie/schemas` is the one spelling of the hashed text, which the control
plane uses too when it names an owner in `codingSessionClose`.

`executeExecutorMcpCommand` asks `CodingSessionsDaemon.callMeta`
(`executor/src/coding-sessions-daemon.ts`) for the `_meta`, and gets one only
for the executor's own bridge: the server named `coding-sessions` whose argv
is `… serve-coding-session-mcp --config <path>`, pinned to the digest the
descriptor's `codingSessions` facts state. Every other server — including a
hand-edited entry under that name — gets no `_meta` at all, and `arguments`
still pass through untouched. The coding-sessions bridge refuses every session
tool when `nessie/owner` is absent.

## Only the name travels

A named server carries a host-local launch spec — argv, working directory,
environment — in the owner-only state file. **None of it ever reaches Nessie.**
This is the same rule as a workspace folder's host path, for the same reason: a
reviewer of an organisation-scoped executor approves a capability, not somebody's
disk layout.

It follows that failure messages are built from the server's *name* and a reason
category, never from the underlying error — a spawn failure's message contains
the argv and the host path. There is a test that constructs exactly that failure
and asserts the reported message carries neither.

Server names join `localPolicyDigest`, so naming a server costs a revision a
person reviews. A name is resolved by **lookup in the configured list, never by
path arithmetic**, which makes "call a server the policy did not name"
unrepresentable rather than merely refused.

## Absent is not empty, at every layer

This distinction carries the whole feature and every layer must preserve it.

| Layer | Absent means | Empty means |
| --- | --- | --- |
| Policy `mcpServers` | fronts no server; both operations refused | *(not representable — the schema has no empty array)* |
| Heartbeat `localMcp` | a daemon too old to report | a daemon that reports and names no server |
| Stored `local_mcp` (SQL NULL) | this executor has never reported | it reported, and named nothing |
| `kelpieDevices` | never probed for instances | probed, and no browser answered |

A `NOT NULL DEFAULT '[]'` on the column would make every pre-existing executor
claim to have answered. The column is nullable with no default on purpose.

### Two readers, one renderer

The three states above have to survive being summarised into prose twice now:
`executor_inspect`'s answer, and the Agent Designer's generated design
catalogue. `formatExecutorLocalMcp` (`@nessie/executor-manage`) is the one
renderer both use — the Personal Assistant's `formatLocalMcp` re-exports it —
because a second copy is precisely how one of the three quietly becomes two.
The catalogue adds a fourth thing it must not flatten into them: somebody who
may *use* an executor but not administer it reads the report as **unreadable
with their access**, never as "has never reported", which is a fact about that
machine nobody established.

An executor grant to an agent is whole-suite, so `mcp.tools` and `mcp.call`
travel with the rest of the reviewed policy rather than being picked
individually — the transport is still only ever onto the servers that policy
names. The rule and its one exclusion (`workspace.promote`) are in
[global-agents.md](global-agents.md).

## Availability rides the heartbeat, never the descriptor

Installing Kelpie must not cost a reviewed policy revision, so what the daemon
observes travels on the heartbeat and is stored beside the report's own
`observedAt`. The field joins the **signed** payload exactly when present;
canonical JSON distinguishes an absent key from a present one, so a daemon that
reports nothing still verifies the payload it always sent.

A heartbeat with the field absent **leaves the stored report alone**. A daemon
that stops reporting has not said its servers vanished, and overwriting the last
observation with nothing would destroy the only thing we know.

Probing must never block a heartbeat: a discovery sweep takes seconds. The
daemon refreshes on its own cadence and every heartbeat carries the last
observation.

## The unavailable reasons are the point

`not_installed`, `launch_failed`, `handshake_failed`, `unsupported_platform` and
`not_probed` send a person to different machines and different actions. Anything
that collapses them — a boolean, a shared error path, a UI that renders them
alike — defeats the report. The session manager once flattened every start
failure to `handshake_failed`; the fix and the test that pins it are in
`executor/test/mcp-session-manager.test.ts`.

## Kelpie specifics

- **No port is ever assumed.** Kelpie announces itself over mDNS and every
  instance picks its own port. The inventory is what the daemon last
  *observed*, and a caller that treats a stale entry as reachable is the
  caller's bug — which is why every entry states its own `lastSeenAt`.
- **Detection asks Kelpie to describe itself** (`kelpie describe --json`),
  through the same program the policy already named for that server. The
  executor never goes looking for a `kelpie` binary of its own: running a
  program the policy did not name is what the policy exists to prevent.
- **A Kelpie whose mDNS browse failed reports absence, not an empty network.**
  It has not found nothing, it has not looked, and "there are no browsers on
  this network" is the one thing it cannot know.
- **`paired` is its own field.** Kelpie refuses every automation method until a
  person pairs on the device itself, so an instance can be discovered and not
  drivable. That is a step a person can take, not a failure, and the admin
  renders it as one.
- Kelpie's document states instances under `discovery.devices`, and its scan
  budget flag is `--scan-timeout`. Both were got wrong first and found only by
  running against the installed Kelpie.

## Ollama account research

An executor may configure an approved named server `ollama-search` using its
installed executable and `serve-ollama-search-mcp`. The exact exported tools are
`ollama_web_search` and `ollama_web_fetch`. The launch specification and
`OLLAMA_API_KEY` stay in the executor's private configuration/environment; the
run receives only the named, approved tool descriptors. The existing agent
grant, executor binding, input schema and command authorization still apply.

These tools call Ollama's fixed HTTPS account API, independently of the local
generation endpoint. They require a configured account credential and available
provider quota. Missing/rejected credentials, quota exhaustion and unavailability
are separate failures, and none selects Ledger or another search provider.
Search is not intrinsic to a bare Ollama model. A direct Desktop binding without
an approved executor MCP binding cannot claim these tools are available.

## Coding sessions

`serve-coding-session-mcp --config <abs>` is the executor's second built-in
bridge: it runs Claude Code or Codex on the host as long-lived sessions that
an agent instructs, follows, interrupts, reviews and closes. It holds no state
in memory — each session belongs to a detached `coding-session-host` — so the
idle close and the probes above cannot take a coding turn with them. Its
output is projected and path-rewritten before it leaves the host, the coding
agent's own account (which the model knows and repeats) reads `<account>`, and
its failures are named codes, never the underlying error. The whole contract is in
[host-coding-sessions.md](../executor-protocol/host-coding-sessions.md).

It is the one named server that is not a program somebody named, and three
rules follow from that:

- **The executor generates its entry.** `configure` takes a `codingSessions`
  object and writes the server itself; a hand-named server called
  `coding-sessions` is refused.
- **Its power facts travel, unlike any other launch spec.** The descriptor's
  `codingSessions` states the agents, their permission modes, the number of
  pre-allowed tools, the root names and the configuration's digest, inside
  `localPolicyDigest`. Paths and programs still stay on the host.
- **Its report carries its open sessions.** The local-MCP status for
  `coding-sessions` may carry `codingSessions`: each open session's id,
  owner key, title, status, agent, root name and `updatedAt` — never what it
  said or did. Absent means the bridge was not asked; only that server may
  carry the field.

Both built-in servers are dispatched by `executor/src/builtin-mcp-cli.ts`.

## Verifying

```bash
pnpm --filter @nessie/executor run test:mcp
pnpm --filter @nessie/admin test:e2e:executor-local-mcp
```

The executor suite drives a **real MCP server subprocess**
(`executor/test/fixtures/scripted-mcp-server.mjs`), because the JSON-RPC
framing, the session lifetime and the teardown are exactly what a stub cannot
prove. It runs with `--test-force-exit` for one pinned upstream reason: on
`@modelcontextprotocol/sdk` 1.29 a transport whose spawn fails with ENOENT
leaves the parent's stdin referenced, so a process that probes a server which is
not installed never exits. A test asserts that leak, and starts failing when the
SDK fixes it — that is the signal to drop the flag.
