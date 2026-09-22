# CTO agent usability test (Windows, 2026-09-22)

A developer-seat walkthrough of one scenario, done entirely through the product
on Ondrej's Windows box: start the app, sign in, ask the Personal Assistant for a
CTO agent that owns a project board, can research, and drives development on a
paired executor, then have that CTO take tickets one by one and fix them on the
machine through Codex or Claude Code. Every step a person would take was taken
in the browser or the chat; the API was called directly only where the product
offered no doorway, and each such case is a finding below.

Model under test: `meta/muse-spark-1.3-contributor` through Ledger's OpenRouter
service (the production default). Instance: a fresh `nessie_cto` database in the
shared local Postgres, API 5454 / admin 5455, a 24-hour Ledger key, DeepWater
left alone on request.

## What worked

- First-run owner setup, sign-in, the Personal Assistant hand-off to the Agent
  Designer, and the Designer's proposal card (name, role, description, location,
  model picker, Accept/Edit/Decline).
- Machine-first executor pairing end to end: eight-digit code from the CLI,
  claim in **Agents → Executors → Pair executor**, fingerprint confirmation,
  machine-side confirm, online heartbeat.
- The reviewed policy revision flow and the whole-suite agent grant, both with
  fresh password verification, and the executor page's live view of local MCP
  servers (`codex`, `claude`) with their availability reason.
- Ticket creation, priority, board placement and `ticket_move` by the CTO once it
  had the tools and the project id.
- The executor transport itself: once the blockers below were patched, the CTO
  listed the Claude Code MCP tools on the machine and issued dozens of `Read`,
  `Grep` and `Bash` calls against the paired worktree, each round trip under
  two seconds, and its report when Codex could not start was accurate.

## Findings

Numbers match the running log kept during the session. "Fixed here" means the
change is in this branch.

### Blockers on the executor loop

1. **Executor tool names break the production model.** Every executor tool was
   offered as `executor.<group>.<op>`; Meta's API refuses a function name with
   more than one dot (`` `name` may contain at most one dot ``), so the first
   model call of any executor-backed run failed with a generic "the model
   provider rejected this request". *Fixed here:* the wire name is now
   `executor_<group>_<op>` (`executorToolName` in
   `worker/src/run/executor-toolset.ts`); registry ids and audit actions keep
   the dotted spelling.
2. **The local-app-tools bundle could not be resolved.** `POST
   /api/executor-availability` with `mcp.tools`/`mcp.call` hit the CHECK
   constraint `executor_availability_candidates_operation_keys_known`, whose list
   stopped in August (no `workspace.review`, no connected-browser trio, no MCP
   pair). *Fixed here:* migration `20260922190000_executor_availability_known_operation_keys`.
3. **An agent granted an executor still cannot use it from a conversation.**
   Executor tools are offered only to a run that already has `executor_bindings`,
   and those are created only by the person's run launcher. The Designer's
   proposal and the CTO's own instructions promise "drives Codex on your
   Windows executor", nothing tells anyone that a person must launch every
   session, and the CTO improvised a sub-agent that could not reach the machine
   either — then reported the work as started (see 18).
4. **The run launcher has no bundle for local app tools.** Seven bundles, none
   with `mcp.tools`/`mcp.call`; on Windows the command and Codex-session
   bundles need the Hyper-V guest, which is not implemented, so the only bundle
   that can drive Codex or Claude Code on this machine cannot be launched from
   the UI at all.
5. **The daemon never recovers from a fenced connection.** After an API
   restart, and again after every policy approval and agent grant, the
   heartbeat's reconnect path re-claims a connection and then fails with
   "Executor state changed before this update could be saved"; the server epoch
   climbs every 20 seconds while the daemon keeps the old one, and only a
   process restart helps (`executor/src/daemon-server.ts`, `daemon.ts`,
   `state-store.ts`).
6. **One recalled memory disables every ticket write in the channel.** With
   embeddings configured, memory recall admitted the requester's private DMs
   into the run's disclosure basis at run start, so `assertProjectWriteDestination`
   refused `ticket_create` with "I cannot copy restricted research into this
   shared project" — for every later run in that channel. Nothing in the UI
   explains it and the agent did not relay the refusal. The test continued in a
   new channel with embeddings switched off.
7. **A person cannot steer an executor-backed run, and a continuation loses the
   executor.** A message posted while the run works only queues; the run it then
   starts, including the "Reply to continue from the saved checkpoint" path, has
   no bindings.
8. **Reading exhausted the run budget.** The Claude Code run spent ~500k tokens
   on 37 read and grep results (each up to 64 KB) before a single edit, then
   stopped at the token backstop.

### Defects

9. Pressing **Accept** on the Designer's proposal card showed "Something went
   wrong" while the press had already been claimed server side; the follow-up
   run failed on the same realtime publish error, the card kept its enabled
   Accept button, and the live thinking panel showed a stale summary.
10. The API process dies when Postgres restarts: an unhandled `error` event on a
    dedicated `pg` Client while the pool reconnects cleanly.
11. The Designer's executor confirmation link arrives with its token redacted
    (`#confirmationToken=PkbZ••••`), so the link it hands the person is dead
    and the ten-minute change expires; the grant had to be redone from the
    executor's Agents tab.
12. The Designer promised board ownership but wrote no ticket tools into the
    CTO's policy; `ticket_*` reach an ordinary agent only through an explicit
    per-project grant. Asked for tickets, the CTO created four Task Sets
    instead and called them tickets.
13. A project-channel agent cannot learn its own project id: `ticket_create`
    requires it, `channel_list` exposes only the project name, `project_list` is
    Designer-only. The person had to paste a UUID into chat.
14. The Designer's DeepWater and "Create Ticket Board" grants fail with
    `invalid_type, expected boolean, received string`; this model sends every
    scalar argument as a string (`"limit":"50"`, `"enabled":"true"`, a
    JSON-encoded `toolPolicy`). Coercion at the tool boundary would remove the
    whole class. It also emits `default.`-prefixed tool names for Meta's
    namespaced protocol and lost several turns to "Unknown tool" — *partly fixed
    here:* the run loop and `tool_spec` now accept `default.<tool>` when the
    remainder is an offered tool.
15. The daemon's local-inference heartbeat violated
    `local_inference_host_sequences_purpose_chk` (`purpose = 'resource'`) on
    every beat, a 500 in the API log every 20 seconds. *Fixed here:* migration
    `20260922190500_local_inference_sequence_resource_purposes`.
16. DeepWater team enablement has no doorway in the admin (the launcher says
    "an organization owner must enable Deep Water for this team first"; no
    screen calls `PATCH .../team-enablement`). On a bearer-only local install
    the route answers `LEDGER_IDENTITY_UNCONFIGURED`.
17. The first-run setup URL the API prints points at the API port, where it
    returns a 401 JSON; the screen lives on the admin port.
18. The CTO reported "I've started it on Minis in the cto-driven-fixes worktree"
    when nothing had been launched, and later called Task Sets "tickets on the
    board".

### Usability

19. No way to stop a running agent from the channel or the agent page; the
    cancel route exists but is wired only into the document-stream dialog. Runs
    looped for ten-plus minutes with only thinking summaries to watch.
20. Deferred tool schemas plus this model make long silent turns: a dozen
    `tool_spec` calls, `file_glob **/*` fishing, and no progress indicator.
21. The Designer's completion message leaks raw UUIDs and echoes an
    instruction meant for the model ("give them this reason word for word").
22. The CTO was created with no portrait ("The avatar prompt could not be
    generated") and no further reason.
23. **A new agent must not get a channel of its own** (Ondrej, during the
    test). The Designer created `#cto` inside the Nessie project as the agent's
    home; agents should simply exist and be added to channels by people.
24. After three failed calls a run disables the tool (`executor_mcp_call`), so
    an agent cannot try a fourth model or argument shape; recovery needs a new
    person-launched run.

### Environment notes (not product defects)

- The shared local Postgres was still bind-mounted from a worktree
  (`.claude/worktrees/executor-page-admin-layout-f90378/.nessie/docker/postgres`)
  and had lost every normally-empty data directory since 2026-09-18; NOTIFY and
  checkpoints had failed for four days. Moved into the named volume with the
  directories restored; both databases came through recovery intact.
- Codex on the machine: the PATH `codex` is 0.141.0 under `C:\ProgramData\npm`,
  too old for the models in `~/.codex/config.toml`; 0.155.1 was installed under
  the user prefix and works, but the ChatGPT account's Codex usage limit is
  exhausted until 2026-09-26, so Claude Code's `mcp serve` carried the executor
  test instead.
- Running the executor from a worktree on Windows needs a packaged runtime
  (bundle, `node.exe`, native helper, manifest) prepared with
  `executor/scripts/prepare-runtime.mjs`, plus `NESSIE_EXECUTOR_PACKAGED_CLI=1`
  and `NESSIE_EXECUTOR_ALLOW_LOCAL_API=1`.

## Changes in this branch

- `api/prisma/migrations/20260922190000_executor_availability_known_operation_keys`
  and `20260922190500_local_inference_sequence_resource_purposes` (findings 2, 15).
- `worker/src/run/executor-toolset.ts` — `executorToolName`; `agent-loop.ts`,
  `auto-review.ts`, `task-sets/search.ts` compare through it; tests updated
  (finding 1).
- `worker/src/run/execute/agent-loop.ts` and `builtin-toolset-deferred.ts` —
  a `default.`/`functions.` prefix is dropped when the remainder is an offered
  tool (finding 14, in part).
- `.claude/launch.json` — `nessie-api` and `nessie-admin` dev entries for the
  browser preview tools.
- `docs/functionality.md` — names the executor actuation tools by their wire name.

## Outcome of the ticket loop

See the closing section of the pull request description for the state of
ticket 1 at the end of the session; findings 3, 4, 7 and 8 are why the loop
needed API-launched runs and a fully scripted prompt to produce an edit.
