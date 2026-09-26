# Stack, agentic-loop run budgets and run lifecycle

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


- Node/TypeScript (strict mode), Fastify, Prisma + PostgreSQL
- Multi-tenancy: Organisation → Team → Project → Channel ([team-model.md](team-model.md)) with `organization_id` scoping on all child tables
- RBAC policy engine with deny-overrides; OIDC SSO with PKCE
- Agentic loop — run budgets (2026-08-05 redesign). The model and the failures
  behind each rule are the spec's:
  [docs/plans/2026-08-05-run-budgets-context-and-research-routing.md](../plans/2026-08-05-run-budgets-context-and-research-routing.md)
  — effective-token metering and the cache-read weight (§2a), the 80%
  wind-down and the ~90% reserved-headroom stop with its `RunCheckpoint`
  (§3/§3a), mid-run org-`Budget` recheck (§4), checkpoint continuation and the
  admin Continue (§5/§6), TaskEvents (§7), per-model context window and real
  compaction (§8), research routing (§9). Facts not restated there:
  - `Agent.effort` (`none | low | medium | high | xhigh`) maps **only** to the
    provider's reasoning control; it never implies a spend cap. `none` is the
    off switch each dialect spells its own way, and whether a turn also
    carries the provider's thinking switch is the connector dialect's
    decision, made per turn ([inference-reasoning.md](inference-reasoning.md)). Per-dimension budget = `Agent.runLimits` (Agent
    Designer "Run limits") `??` the deployment backstop
    (`NESSIE_RUN_BACKSTOP_MAX_{TOKENS,TOOL_CALLS,ITERATIONS,WALLCLOCK_MS,COST_CENTS}`,
    defaults 500k / 2000 / 1000 / 45 min / 2000¢ — a safety envelope, not a
    user budget; `worker/src/run/run-budget.ts`).
  - A stop is classified `iteration_limit` / `tool_call_limit` / `time_limit` /
    `token_limit` / `cost_limit` / `repeated_tool_calls` / `org_budget_blocked`
    (`budget-stop.ts`); member-visible copy carries **no currency figures**.
  - Terminal input repeats are counted per session until a different input is
    sent to that session. Enter after a new command must remain usable through
    the entire run. Reading the screen or using another session does not reset
    repeated identical input; counts survive checkpoint resume. Ordinary tools
    retain their cumulative repeat guard.
  - Main conversational turns do not set an application output-token cap.
    The common system prompt asks for complete, proportionate communication;
    real context and run/org spend budgets remain independent safeguards.
    Shared utility and delegate inference also omit the former blanket 2,048
    output cap. Purpose-specific extraction limits remain explicit at their
    callers. Metering includes utility calls; a run budget can still overshoot
    by the cost of its last provider call before the next budget check.
    A protocol which requires an output field may use only its provider
    catalogue's advertised maximum. Kimi's Messages lane discovers `/v1/models`
    and uses `max_output_tokens`, or its advertised `context_length` when Kimi
    exposes no separate output maximum.
  - Normal text-only completion is checked by a metered utility-model
    `{needsFollowUp, reason}` decision. A true decision continues the same run
    at most twice, without changing its permissions or replaying completed
    tools. The correction count is checkpointed and existing cancellation,
    approval, provider-recovery and budget stops take precedence. See
    [agent voice](agent-voice.md) for the completion contract.
  - The cache-read weight resolves once per run from the org
    `ModelPricingProfile` (`cacheReadPerMillion / inputPerMillion`, clamped to
    [0,1]), else `NESSIE_CACHE_READ_WEIGHT` (0.25).
  - Non-interactive runs (`payload.interactive !== true`) never ask and
    auto-continue up to `NESSIE_RUN_AUTO_CONTINUATIONS` (default 2), yielding to
    the per-(agent, thread) slot when busy. `delegate` sub-agents take a fixed
    small budget capped by `NESSIE_MAX_DELEGATES_PER_RUN` (16) and — like
    compaction — use `NESSIE_UTILITY_MODEL` when it resolves through the run's
    own org provider.
  - Tool results (builtin, MCP, `delegate`) are truncated **middle-out** at the
    single loop chokepoint (head ~70% / tail ~30%, idempotent). Per-tool caps:
    4,000 chars for `web_search`/`web_fetch`/`document_read`, 12,000 for raw
    `http_fetch` bodies, 32,000 as the ceiling (`worker/src/run/tool-util.ts`).
    A local program's answer through `executor_mcp_call` is shaped before that
    chokepoint and capped at 12,000 chars with a "narrower result" hint, its
    images and links reduced to placeholders
    (`worker/src/run/executor-result-presentation.ts`,
    [executor-local-mcp.md](executor-local-mcp.md)); the images it kept are
    shown in one turn after the batch, within the prompt's 6-image budget
    ([file-storage.md](file-storage.md)).
  - **Tool timeouts are per tool.** `executeToolBatch` asks
    `toolTimeoutMsFor(toolName)`: an executor tool gets its command TTL plus
    `EXECUTOR_TOOL_TIMEOUT_MARGIN_MS` (10 s), every other tool the budget's
    `toolTimeoutMs` (75 s main, 25 s delegate). An executor timeout raises the
    same fatal `ExecutorUnknownOutcomeError` as an expired TTL — the run is
    requeued and its replay reports an unknown outcome — never a retriable
    "timed out", because the command may still complete on the machine and a
    retry would repeat its side effect. `executor_mcp_tools` is the one
    executor tool that is several commands: the agent loop answers it with a
    catalog walk of up to
    `EXECUTOR_MCP_CATALOG_MAX_PAGES` (16) `mcp.tools` pages in sequence, each
    its own command on its own TTL and each waiting its own turn in the
    machine's lane, so its timeout is sixteen commands' worth; one command's
    worth fired before a second page's TTL did. The toolset chooses each
    command's ToolCall id before creating it, so the backstop's unknown outcome
    names that row and the batch ends it instead of opening a second one; a
    walk that throws also ends its first page's row, which its answer would
    have ended. `coding_session_wait` is the other: a worker-side wait of
    `session_status` reads every 5 s for up to 10 minutes
    (`CODING_WAIT_WINDOW_MS`, `worker/src/run/coding-session-wait.ts`), whose
    timeout is `CODING_WAIT_TOOL_TIMEOUT_MS` (10.5 min). Each read's command
    expires no later than the wait's own deadline, that timeout less the
    margin, so the backstop never fires on a wait that was only sleeping; a
    read whose own TTL runs out is an unknown outcome like any command, and a
    late read whose expiry the deadline shortened just ends the wait with what
    it has. Nothing is outstanding on the machine's lane between reads. The
    window also ends where the run's own wallclock enters its wind-down
    (`WIND_DOWN_FRACTION` of `maxWallclockMs`, passed by the agent loop as
    `runWindDownAt`): the wait then answers "This run is nearly out of time…"
    and the agent still has the rest of the run to say where the session
    stands; a wait begun past that point reads once and returns. The command
    TTLs live in `worker/src/run/executor-command-timing.ts`; `mcp.tools`/`mcp.call` use
    `EXECUTOR_MCP_COMMAND_TTL_MS` (140 s) from `@nessie/schemas`
    `executor-timing.ts`, which must stay ≥ the daemon's worst case for one
    command (a 10 s start + one 60 s call deadline, which also bounds a whole
    `tools/list` walk; the reporter's probe yields to commands) + upload
    budget (50 s) + lane overhead (20 s); `executor/test/mcp-timing.test.ts`
    pins it against the session manager's
    `EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS`.

    **What a coding wait costs.** Its reads cost nothing against the run's
    budgets; each time a wait *returns*, the model reads the whole context
    again — one full-context inference per return, which counts the run's
    context size against the 500 000-token backstop every time (an uncached
    30–40 k-token CTO context reaches the 80 % wind-down in ten to thirteen
    inferences). The window is long for that reason: a twenty-minute coding
    turn is two waits, not five, so start → turn → review → correction →
    second turn → review → reply is about nine inferences where a four-minute
    window took thirteen. A turn longer than what is left of the run
    (`maxTurnMinutes` defaults to 45, as does the wallclock backstop) outlives
    it; nothing wakes the agent when that turn ends, and the person learns of
    it by writing again — a known gap, recorded as a follow-up in
    [the plan](../plans/2026-09-22-executor-local-apps/coding-sessions.md) →
    "Follow-ups".

    **Ticket work** runs are clamped to `TICKET_WORK_RUN_CEILING`
    (`worker/src/run/run-budget.ts`) whatever the agent's own limits say,
    and a ticket's wait reads for at most a minute: the agent starts or
    steers the coding agent and ends its turn, and the turn's end wakes it
    (T5). Around the runs sit the ticket's and the policy's own limits —
    `wakesPerTicket` and `startsPerDay` on the trigger, `ticketHours`,
    `ticketUsd` and `dailyUsd` on the policy (the hours are the record's
    clock, which runs only while the work is active and owes nobody an
    answer), a turn bounded by the machine's signed per-turn `maxBudgetUsd` —
    enforced by the platform at every wake, by the binder, in the heartbeat
    intake and by `ticket-work.sweep`. The coding cost counted against
    `ticketUsd` and `dailyUsd` is what the machine itself reports for each of
    the ticket's sessions on every heartbeat, whether or not a run reads the
    session, and what any coding answer carries (a send, a status read, a
    review); each is counted once. The day's spend stops only running work:
    work that did not spend it is queued until the UTC day turns
    ([ticket-work-machine-access.md](ticket-work-machine-access.md) →
    "Server-side closes, limits and spend").
  - **Executor calls in one batch run in call order**, one after another; the
    batch's other tools still run in parallel beside them. A fatal executor
    call stops the ones queued behind it from dispatching (nothing claimed
    them, so the replay dispatches them). The worker holds
    `EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY` (4) `executor.command` jobs at
    once, so one machine's long call cannot delay another machine's command.
  - **Circuit breaker.** Three consecutive failures of one key disable it for
    the run (the counts ride the crash checkpoint). The key is the tool name,
    except `executor_mcp_call`, which is keyed
    `executor_mcp_call:<server>:<tool>`, and `executor_mcp_tools`, keyed
    `executor_mcp_tools:<server>` (`circuitBreakerKey`), so one program's
    flaky tool never disables the others behind the transport. The breaker and
    the loop detector count a call under the offered name, with a provider's
    `default.` / `functions.` prefix dropped (`normalizeToolName`), so a
    prefixed call is keyed and ruled like the bare one. A
    result marked `correctable` — a failure the model fixes by changing its
    call: `EXECUTOR_COMMAND_ARGUMENTS_INVALID`, `EXECUTOR_MCP_RESULT_TOO_LARGE`,
    `EXECUTOR_MCP_CURSOR_INVALID`, an executor tool name the run does not
    offer, or an MCP server refusing an unknown tool or arguments that fail its
    input schema, and the coding-sessions bridge's own refusals of a session
    or an argument (`coding_session_not_found`, `…_closed`, `…_failed`,
    `…_quota_exceeded`, `…_invalid_arguments`, a root or path it does not
    know) — goes back to the model and neither counts nor clears a
    count; replays keep the flag.
  - **Loop detection** (`worker/src/run/tool-loop-detection.ts`) is decided
    before dispatch. The third identical name+arguments call anywhere in the
    run is refused and the model told to stop and answer. Observation tools
    (`OBSERVATION_TOOL_NAMES`: `executor_mcp_tools`, `coding_session_list`,
    `coding_session_review`, `coding_session_wait`) are exempt from
    that rule: only consecutive identical calls count, any other call resets
    the streak, and the fourth in a row is refused with "The result has not
    changed. Wait with a different call, or tell the person where things
    stand and end your turn." — for the two coding ones, with "The coding
    session's answer has not changed. If it is working, call
    coding_session_wait; if it is waiting for you, send it feedback or close
    it; otherwise tell the person where things stand and end your turn." A
    wait (`WATCH_TOOL_NAMES`) reports after it ran whether the session moved
    and why it stopped (`AgenticToolResult.watch`: `progressed`, and a state
    of `watching`, `needs_model` or `end_turn`), and is judged by that:
    - **Watching** — the session was still working, or the machine did not
      answer in time. Waiting again is the tool working, so it is never
      refused; its streak counts only the waits that saw nothing move, and
      the third such wait in a row gets "The coding agent is still working;
      that is normal. Wait again, or tell the person where things stand and
      end your turn." after the batch instead of a refusal. The streak is
      the session's, like the refusal below: a wait written differently on
      the same session continues it.
    - **Needs the model** — the turn ended, or the session was interrupted,
      failed or closed. (A turn that ended with background tasks still
      running counts as watching: a task finishing starts a turn of its
      own.) The wait's own answer says what to do, and a second
      wait would return the same answer at once, so another wait on that
      session is refused ("Not run: your last wait on this session already
      returned because it needs you…") until a call that is not an
      observation — a send, an interrupt, a close, a start, or anything else
      that can change what the wait would see — ends it. The refusal is keyed
      by the session the wait names, not by its arguments' text, so an extra
      key or a double-encoded object does not get round it.
    - **End the turn** — the person wrote in the conversation or stopped the
      run, or the run's wallclock entered its wind-down. Every later wait in
      the run would stop for the same reason, so every one of them is refused
      with "Stop waiting and end your turn now with one line saying where the
      coding session stands…".

    Counts are checkpointed under `#repeat:` / `#observe:` keys, and the two
    wait markers under `#settled:` / `#ended:`; unprefixed counts from an
    earlier deploy are dropped on resume, and a wait's key written by its
    whole arguments object comes back under the session it names.
  - A provider `finish_reason: length` gets one bounded recovery. Partial prose
    uses a no-tools finalisation from completed evidence. Empty reasoning-only
    output retains tools to finish the already authorized work; a truncated tool
    frame is never dispatched and gets one tool-enabled regeneration under the
    same identity and effect ledger. Crash state carries the mode. Repeated length
    is `provider_output_limit`, never `token_limit`; empty recovery remains
    `empty_provider_response`. An empty success also retains tools for one
    bounded recovery, even after earlier tool calls: no visible answer is not
    evidence that the work is complete. A recovered text answer still passes
    the structured completion review; repeated empty responses fail visibly.
  - **Jev gates.** The structured completion review (`reviewFollowUp`,
    `worker/src/run/follow-up-review.ts`) sends the whole transcript to the
    utility model after every text answer. Jev is asked first, over a bounded
    digest (`completionDigest`, `packages/runtime/src/run-decisions.ts`):
    the latest request, up to four turns before it, this turn's tool calls
    with excerpted results — the oldest dropped first to stay under 18 KB,
    with the number dropped said — and the proposed answer; never the system
    prompt or the agent's documents. At 0.9 or more on `complete`
    (`COMPLETION_MINIMUM_PROBABILITY`) the review is skipped. Jev never sends
    a run back to work: `unfinished`, doubt, a timeout (4 s) or a failure
    asks the generative review, whose written reason is what a continuing
    turn is told. The same evaluator answers a rolling watch's disposition
    first ([rolling-watch-status.md](rolling-watch-status.md)). The evaluator
    (`RunInference.decide`) is the installation's Ledger route attributed to
    the run; a run on a personal subscription or a local model has none, so
    its evidence stays in its own lane and it keeps the generative judges.
    Jev's usage is recorded in the installation's usage ledger, not in the
    run's invocation totals (about $0.00003 a call). The security judges —
    tool auto-review, the send boundary and disclosure sharing — stay
    generative: a confident classifier mistake there is a disclosure, not a
    wasted call.
  - **Memory capture's extraction gate.** Every captured thought — each person's
    message, a run's consolidated memories, a remembered note — paid for two
    generative JSON extractions: metadata (people, topics, kind, action items,
    dates) and decision reasoning. Where the deployment reaches Ledger,
    `captureThought` (`packages/memory/src/capture.ts`) first asks Jev
    (`gateExtraction`, `packages/memory/src/extraction-gate.ts`), beside the
    embedding, over the same first 4,000 characters: is there anything worth
    indexing, what kind of note it is, and does it explain a decision. A sure
    "nothing to index" (0.8, `EXTRACTION_GATE_MINIMUM_PROBABILITY`) stores
    empty metadata of Jev's kind (a note when unsure) without generating it; a
    sure "no reasoning" skips the reasoning extraction. Anything unsure, and any
    failure, extracts exactly as before. The API's and the worker's capture
    configs carry the same Ledger decision client as the orchestrator.
    A finished run's memory consolidation is gated the same way: its
    candidate extraction, a generative call over the run's conversation
    after every completed run, is skipped when Jev is sure (0.9,
    `CONSOLIDATION_GATE_MINIMUM_PROBABILITY`) the conversation holds nothing
    durable (`gateCandidateExtraction`, wired in
    `worker/src/run/memory-consolidation.ts`). Only a conversation Jev can
    read whole, under 18 KB as the extraction sees it, is judged; a longer
    one, doubt or a failure extracts as before.

  - MCP tool descriptors are name-sorted with exposed names allocated in a
    fixed order, so the tool array is byte-identical across iterations and the
    prompt-cache prefix survives. Builtin sets above
    `NESSIE_BUILTIN_INLINE_TOOL_LIMIT` (default 20) keep a hot set inline and
    serve the rest through the non-mutating `tool_spec` meta tool
    ([docs/context-window-optimization-audit.md](../context-window-optimization-audit.md)).
    The hot set is the fixed list plus what this agent was deliberately given
    — the project tools the run was lent, then every tool its policy sets
    `true` — capped at `BUILTIN_PROMOTED_SCHEMA_BUDGET_CHARS` (24,000
    characters of full descriptors, about 6k tokens) in that priority order;
    past the cap a grant stays a stub. Promotion never widens authorization:
    only an allowed tool can be promoted.
  - Every run records a wall-clock-only stage breakdown at its terminal state
    (completion **and** failure) as a `run.timing` `TaskEvent` — `{ outcome,
    runId, queueWaitMs, totalMs, inferenceMs, inferenceCount, toolMs,
    toolCount }`, no cost data (`run-timing.ts`), written after the status flip
    so it can never fail a finished run. Owners: `GET /api/ledger/runs/timing`.

- **Budget and storage-quota admission are atomic, and say what they promise.**
  A run enters through `admitRunToBudget` (`packages/runtime/src/budget.ts`),
  not `evaluateBudget`: for an `enforce`/`degrade` budget with a limit it takes
  `pg_advisory_xact_lock` on the governing scope, reads recorded spend **plus
  the ceilings of runs already admitted and not yet settled**
  (`budget_reservations`, written from the run's `Agent.runLimits` ?? backstop
  envelope), and reserves inside one transaction. The guarantee is that
  admissions for one scope are serialised and a run that has recorded nothing
  yet is counted at its **full ceiling**, so two runs that fit one at a time but
  not together can never both be admitted, however many replicas are admitting.
  **State its limit alongside it** — an overclaimed cap is worse than an
  honestly documented soft one. The reservation is dropped by
  `recordInferenceUsage` on the run's **first** recorded usage (leaving the
  estimate beside the real number would double-count it), so from then on the
  run counts at what it has recorded, not at what it may still spend: "past the
  cap by at most one ceiling" is exact only while the competing runs have not
  started spending, and across a period of long, partially-recorded runs the
  excess is bounded by their unrecorded headroom instead. Bounding a single
  run's own total remains the envelope's and the mid-run recheck's job.
  Reservations are an estimate, so only admission reads them: `/ops/usage`,
  `listBudgetStatuses` and the mid-run recheck stay on recorded spend. A
  reservation is ignored once its run is terminal, and swept in
  `worker/src/control/budget-reservation-sweep.ts`. `warn`/`unlimited`/`off`
  never take the lock. The storage quota is the same shape:
  `withStorageAdmission` (`packages/runtime/src/storage-quota.ts`) runs the
  check and the `storage_usage_events` writes in one transaction under the
  organisation's lock, which makes it exact rather than "exact modulo
  concurrent uploads". **Both** paths that store bytes go through it — the
  upload itself (`files/index.ts`) and the deferred preview backfill
  (`files/attachment-thumbnails.ts`, whose pre-check is only a cheap early-out);
  a preview is stored bytes like any other, so a check that is not atomic with
  the write making it visible would reopen the same race. What the guarantee
  rests on is that `FileService` is the only writer of those bytes.
- **Budget threshold alerts + failed-run attribution** (local ops only, never
  UOA credits). The gate no longer only observes usage passively: `evaluateBudget`
  (`packages/runtime/src/budget.ts`) returns the byte-identical verdict PLUS an
  alert snapshot, and `applyBudgetGate` fires **at most once per budget scope per
  period** when cumulative spend first crosses `Budget.warnThresholdPercent`
  ('threshold') or first blocks a run ('blocked'). Alerting runs AFTER the verdict
  is applied and swallows its own errors, so blocking behaviour is unchanged.
  Durable crash-safe dedupe = a `budget_alerts` marker row unique on
  `(scopeType, scopeId, periodStart, kind)`; each alert emits a
  `budget.threshold_alert` `TaskEvent` and enqueues `budget.alert-dispatch`,
  notifying org owners + the scope's managers through the shared push pipeline
  (`worker/src/control/push-delivery-core.ts`), respecting preferences and
  deep-linking `/ops/usage`. Every terminal run persists its inference spend —
  the generic failure/crash path too, via a caller-owned invocation accumulator
  threaded through `runAgenticLoop`, so a failed run's tokens stay attributable
  (idempotent on `inferenceInvocationId`). Owners read spend by run outcome at
  `GET /api/ledger/tokens/by-outcome`.
- **Three kinds of checkpoint, one row per run.** All three live on
  `run_checkpoints`, which is unique on `run_id`; they never collide because
  they occupy different columns.
  - **Budget stop** (`run-stop.ts`) and **suspension** (`run-suspend.ts`,
    reason `approval_required` / `card_response` / `wound_down`) both write the
    model-authored `note` + `sources`: an affordance a *person* acts on, resumed
    by a NEW run through `POST /api/runs/:id/continue` or the worker's
    auto-continuation. Untrusted narrative, re-injected under an explicit
    untrusted framing.
  - **Who resumes one** (`loadRunCheckpointForRun`). A continuation claimed
    for it — the Continue press, an approval or card resume, the worker's
    auto-continuation, each after its own gate — or a person's own reply in
    the conversation it stopped in: the same agent and Personal Assistant
    principal, the same thread and reply root, and a checkpoint that person
    may read, checked before the one-shot claim with the predicate run setup
    admits it by. Every other run leaves it alone — a schedule, an event
    trigger, a channel policy, a wake, another agent, a member who may not
    read it. It used to go to the next run in the thread, whatever that was:
    a schedule answered from a person's working notes and was stamped with
    their sources, and a member who could not read them consumed them and
    dropped them (`worker/test/db/checkpoint-resume-scope.test.ts`).
  - **A continuation waits for a busy thread.** An auto-continuation that
    finds its (agent, thread) slot taken queues itself again
    (`startAutoContinuation`, topic `run.auto_continuation`; 15 s doubling to
    5 min, twelve tries, about 45 min) instead of leaving the work to the run
    holding the slot, which no longer takes a checkpoint it was not handed. It
    stops once someone resumes the checkpoint, and after its last try leaves
    it for a Continue press or reply.
  - **Crash** (`worker/src/run/execute/crash-checkpoint.ts`, reason `crash`,
    empty note) is machine state that nobody renders: the assembled transcript,
    the loop iteration count, the live inference-invocation accumulator, spend
    and wall-clock consumed, compaction attempts, loop-detection counters, the
    tool calls already executed with their recorded results, and the tool batch
    that was dispatching. It is written at **every agentic-loop iteration
    boundary, immediately before each tool batch, and as each tool in that batch
    settles**, and its point is that the SAME run resumes IN PLACE — no
    continuation run, no new run id.
  - **Resume rules.** `claimRunForExecution` reports the status the run carried
    before the claim; a `running` one is a takeover, so `executeRunJob` loads
    the crash state and hands it to the loop instead of the prompt. The loop
    restores the transcript, iteration count, accumulator and budget; a tool
    call whose result is recorded is answered from the record without
    re-authorising or re-dispatching; a batch that was mid-dispatch is
    re-entered rather than re-asked of the provider (its assistant message is
    already the tail of the transcript). With no checkpoint the run starts from
    the prompt exactly as before and says so in a log line.
  - **Fencing and lifetime.** Every crash write is conditional on
    `runs.executor_token` still equalling the token this execution claimed with,
    so a fenced-out executor's write matches zero rows. `updateRunStatus` sheds
    the crash state on every terminal *and* suspended transition — a row that
    only ever held crash state is deleted, one a stop or suspension has since
    written its note into keeps everything but the crash columns. A transcript
    over 4 MB (inlined images) is not checkpointed at all: the run degrades to
    replay, and the log line says which run. A tool's images never count
    toward it: the transcript, and a recorded tool result, hold them as
    attachment refs, and a resumed or re-entered run reads them again from
    `FileService` when it next builds a provider input
    ([file-storage.md](file-storage.md)).
  - **Drain.** The queue's per-job `AbortSignal` reaches the loop
    (`worker/src/index.ts` → `executeRunJob` → `runAgenticLoop`). When it fires,
    whatever is in flight gets `NESSIE_RUN_DRAIN_GRACE_MS` (default 5 s) and the
    loop then throws `RunDrainedError`; the run keeps its `running` status, its
    executor token and heartbeat are cleared through the same fenced hand-back
    used by every intentional queue retry, so the next worker claims it on its
    very next poll, and the job is nacked with reason `worker_drain`. Nothing is
    announced in the thread: a drain is this worker stopping, not this run
    failing. A re-entered batch re-emits `agent.tool.start`/`end` and writes a
    second `ToolCall` telemetry row for a tool that did not re-run; the tool's
    effect on the world happens once, which is the invariant that matters.
  - **Completion.** The final answer/fold, reply metadata, completed run, done
    task, idle agent and a keyed completion-follow-up job share one database
    transaction. Realtime publication, terminal cleanup and parent
    plan/delegation/workflow transitions run from that durable job with stable
    per-audience event keys. A fault after the answer therefore redelivers the
    remaining work without changing the terminal status or posting the answer
    again; a newer run's active agent state is never reset by the replay. The
    worker verifies the completed run and its keyed follow-up after an ambiguous
    transaction acknowledgement before entering any failure path. Verification
    locks the run row and reads the follow-up in the same transaction, which
    waits for an in-flight COMMIT and cannot combine two snapshots. If that
    readback is unavailable, it hands the claim back and asks the queue for a
    delayed retry without spending retry capacity. The
    parent workflow's non-terminal continuation has its own stable queue key,
    so replay after finishing its step cannot schedule it twice. Mention alerts
    and interactive reply pushes use stable keys and retry transient persistence
    or publication failures without duplicate notifications. Workflow
    terminal event/card announcements retain the workflow subsystem's existing
    best-effort contract and are outside this completion guarantee. Memory-job
    enqueue failures redeliver the completion follow-up; only structurally
    missing user/team attribution is a permanent skip. Pending-message drain
    also has an independent `sweepPendingThreadMessages` recovery owner.
- Active run lifecycle controls (`api/src/routes/runs.ts` +
  `api/src/services/runs.ts`): org-scoped `GET /api/runs/active` lists live runs
  (+ recently-ended restartable ones); `POST /api/runs/:id/cancel` cancels — a
  queued/approval-suspended run flips straight to `cancelled` (never executes),
  a running run gets a cooperative `cancelRequestedAt` flag the loop polls
  between iterations and tool batches, exiting via the classified-stop
  machinery (`worker/src/run/execute/cancel-stop.ts`, mirroring budget-stop:
  partial text + a "cancelled" notice + `run.cancelled` `TaskEvent`).
  `POST /api/runs/:id/restart` re-runs a terminal `failed`/`cancelled` run,
  replaying the same trigger message and linking via `Run.restartOfRunId`.
  `POST /api/runs/:id/continue` (`api/src/services/run-continuation.ts`)
  resumes a terminal run from its unconsumed `RunCheckpoint`: same channel
  access that could have triggered the run, one transaction claiming the
  checkpoint (set-once `consumedByRunId`) + creating the continuation run
  (`Run.continuationOfRunId`) + task + enqueue; 409s: `RUN_BUSY`,
  `RUN_CHECKPOINT_CONSUMED`, `RUN_NOT_CONTINUABLE`. A run whose
  trigger message carries `integrationLaunch` metadata (DeepWater handoff) is
  rejected from cancel/restart/continue with `409 RUN_HANDOFF_MANAGED` → use
  `research_cancel`; the
  handoff invariants are never touched. `Run.triggerMessageId` (populated by the
  chat orchestrator + integration handoffs) backs both the guard and the replay.
  Admin cancel is surfaced where a person watches a run — a **Stop** icon on
  every thinking bubble and beside the agent page's status pill
  (`admin/src/components/shared/RunStopButton.tsx`, `useCancelRun`) — and on
  the live document-stream dialog; Continue on budget-stop notices
  (`admin/src/components/features/channels/RunStopContinue.tsx`, `useContinueRun`).
  Stop is drawn only while its surface already knows the run is live: a bubble
  exists from `stream.start` to `stream.done` (a `running` run; suspension and
  cancel both publish the `done`), and the agent status read (and the
  realtime snapshot) names a `currentRunId` for a run the viewer may read in
  any live status — `pending`, `running`, `waiting_approval`,
  `waiting_input` — so a suspended run's Stop is the agent header's; a
  suspended run names no active tool. The
  press holds "Stopping…" until that surface drops the run, because the flag
  is read between iterations, after a tool batch settles, and before each of
  a batch's in-order executor calls is sent (`stopRequested` in
  `executeToolBatch`; an unsent one answers "Not run: the person stopped this
  run…"). A call already sent runs to its end, so the wait is at most one
  executor call's TTL plus margin (130 s for `mcp.call`) or a model or other
  tool's own timeout. Stop never adds a line to the composer.
  `pnpm --filter @nessie/admin test:e2e:run-stop` pins the button, the pending
  state and the request. The standalone Agents → Activity page and its
  `RunLifecyclePanel` were removed,
  so the org-wide active-run list and the restart control have no admin surface
  (the `GET /api/runs/active` and `POST /api/runs/:id/restart` endpoints remain,
  API-only).
- MCP connector management (REST, not JSON-RPC): `api/src/routes/mcp.ts`
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery

## Deep.Agent compaction

Nessie consumes only `@deep/agent`'s commit-pinned, pure
`runContextCompaction` helper. Nessie still owns utility inference and its
invocation sink, checkpoint persistence, disclosure basis and durable state.
The helper preserves complete tool groups, fences its rolling note and retains
source URLs.

Compaction runs automatically at the context threshold and when output admission
requires more space. It uses the run's utility model when configured, otherwise
the run model. This is deliberately machine-only: no separate page, user action,
or HTTP service is required. People receive the normal answer or saved checkpoint;
the internal summary is context for the next inference.

CI and Docker require the externally managed `DEEP_AGENT_READ_TOKEN`: a
fine-grained token scoped only to `deep.agent` Contents:Read, rotated before
expiry. It is supplied only to installation and is never committed, persisted
in an image layer, or exposed at runtime.
