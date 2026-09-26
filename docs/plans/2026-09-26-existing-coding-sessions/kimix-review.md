# Kimix plan review

Date: 2026-09-26. [Plan](overview.md) · [Provider evidence](provider-findings.md).

The review below records the initial plan. The user's subsequent instruction
supersedes its per-session/action grants and separate attachment consent:
existing executor authorization is enough, with one default-on disable toggle
across three CLI and two GUI executors. Provider transport prerequisites still
need proving. The historical review is not approval of an implemented feature.

Reviewer: installed Kimix CLI, Kimi provider, configured `k3` model. Review
ran read-only in a separate worktree at `150e88c77`, against Nessie base
`abd544dbd99ede1d9615fc782e1cc52e1fb552d1`. It read the proposal and relevant
executor, worker, owner-policy, session-sharing and UI code. It made no code
changes and did not run live provider injection or browser flows.

## Verdict

**READY WITH GATES.** Kimix found the narrow request preserved and the provider
unknowns accurately labelled. This is approval of a research-gated plan, not
proof that the feature works. Exact-existing-conversation delivery on all
three platforms remains the phase-0 gate.

Kimix then reviewed the revisions through `8f4dac5db` in a second read-only
pass. Final verdict: **READY as a research-gated plan**. It confirmed all four
findings and four missing acceptance cases were addressed, and found no new
access paths or contradictory action semantics.

## Findings and disposition

| Finding | Change to the plan |
| --- | --- |
| Moderate: Codex external-session approval handling was unspecified. | Both adapters observe permission prompts only. The original human client answers; attaching cannot seize approvals or change permission settings. |
| Moderate: Queue/Push/Steer tool mapping was left to implementation. | Added exact agent/bridge mapping. Reuse list/status/wait/interrupt; add three explicit input actions. Managed send/start/review/close and terminal writes refuse external targets. The initial separate attach/grant workflow was later removed by the user's instruction. |
| Moderate: existing session-screen sharing could disclose human conversation content. | External sessions have `canShare: false`; the API rejects share mutations and legacy share-based reads. Sharing is outside this MVP. |
| Question: Windows service-account versus signed-in-user discovery was ambiguous. | Restrict discovery/attachment to the executor OS account and configured provider profiles, and add cross-account refusal tests. |

Kimix also requested explicit acceptance cases for provider auto-update,
human close/delete with native queued input, permission prompts on submitted
work, and separate PATH/desktop-binary matrix rows. All are now in phase 0.
The initial standing-ticket attachment restriction was also superseded:
standing work now follows existing executor authorization, without another
attachment approval.

## Validation boundary

The reviewer checked the current managed process teardown against the proposed
detach invariant; the original `session_send` semantics; owner-only authority;
the existing `ExecutorSessionPage` and session-sharing route; and whether the
plan could mislabel saved threads or unacknowledged channel events as live
control. It accepted the remaining experiments as explicit release gates.

No implementation, real delivery, native installation or rendered-flow test is
claimed by this review. A separate implementation review is required after
those gates are met.


## Implementation review

The installed Kimix CLI independently reviewed implementation `85acfd8ae`
against `83499af11` in a separate read-only worktree. It inspected the plan,
executor adapters, API ownership filters, worker tools and UI. It made no
changes. Provider consumption and native UI behavior require separate runtime
proof; the reviewer did not claim to verify them.

| Finding | Implementation disposition |
| --- | --- |
| Shared connections collected unusable native titles. | Background inventory now requires the existing heartbeat's private-scope receipt. Database tests cover private, project and organization scopes. |
| Native discovery ran every 15 seconds. | Background inventory shares a 60-second cache; explicit requests refresh it. |
| Missing Codex provider could reach Claude input handling. | Native reads and writes select their provider explicitly and reject absence. |
| Describe hardcoded the enabled flag. | The CLI reads the persisted local switch; the synchronous projection no longer invents it. |
| List filters did not apply to managed sessions. | The tool contract explicitly scopes filters to native inventory. |
| One transient queue probe failure persisted forever. | Unsupported or failed probes are retried on later discovery. |
| Delivery records and results grew indefinitely. | Receipts are capped at 4,096 without evicting deduplication records; channel results are reconciled and removed. Exhaustion rejects new work. |
| Claude channel setup had no local doorway. | The shared console and CLI describe output provide the exact native MCP configuration. |
| Restart notice and binary selection were misleading. | Local controls describe immediate application; Windows Codex candidates are ordered by modification time. |

Follow-up checks also cover channel claim-before-write, ordered delivery,
disabling between events, expired authority, native incarnation mismatch,
expired input and ambiguous writes without replay. Provider output is scrubbed
through the existing secret/path projection. Admin history navigation uses the
real navigation providers in its browser fixture. Both native console transport
adapters are exercised by the shared headless renderer harness.


The follow-up contract audit found that the API route's strict heartbeat
response schema also needed the additive `existingSessionsAllowed` field.
The shared wire schema now retains both boolean values, and the HTTP route
regression verifies private `true` and shared `false` responses. Testing only
the management function would not have caught the route serialization failure.

The independent follow-up reviewed `85acfd8ae..32bf2e773` and confirmed all
nine implementation findings resolved. Its remaining findings were checked
against the integrated code:

- The strict heartbeat response defect is fixed as described above; all seven
  focused signed HTTP route cases passed.
- Expired Claude events now release queue capacity even when no channel is
  draining. Cleanup claims each file before recording cancellation.
- Concurrent channel drains tolerate another process claiming the same event.
  A durable regression checks that both drains finish and each event is sent once.
- Windows Codex installations are sorted before limiting executable candidates
  to 64, so an older directory listing cannot hide the newest installation.
- An earlier development commit used a different receipt shape. That commit
  never shipped; disposable test state was replaced, and no production
  compatibility layer was added.

The follow-up's runtime caveats were based on its earlier review snapshot.
Subsequent Windows and Linux native results are recorded in
[verification](verification.md). A new executor connected to an older server
keeps native discovery and channel delivery off until the server supplies the
existing-scope heartbeat field; deploy the server before updating executors.
