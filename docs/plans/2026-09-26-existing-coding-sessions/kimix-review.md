# Kimix plan review

Date: 2026-09-26. [Plan](overview.md) · [Provider evidence](provider-findings.md).

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

## Findings and disposition

| Finding | Change to the plan |
| --- | --- |
| Moderate: Codex external-session approval handling was unspecified. | Both adapters observe permission prompts only. The original human client answers; attaching cannot seize approvals or change permission settings. |
| Moderate: Queue/Push/Steer tool mapping was left to implementation. | Added exact agent/bridge mapping. Reuse list/status/wait/interrupt; add three explicit input actions. Managed send/start/review/close and terminal writes refuse external targets. Attach/grant remains a human policy action. |
| Moderate: existing session-screen sharing could disclose human conversation content. | External sessions have `canShare: false`; the API rejects share mutations and legacy share-based reads. Sharing is outside this MVP. |
| Question: Windows service-account versus signed-in-user discovery was ambiguous. | Restrict discovery/attachment to the executor OS account and configured provider profiles, and add cross-account refusal tests. |

Kimix also requested explicit acceptance cases for provider auto-update,
human close/delete with native queued input, permission prompts on submitted
work, and separate PATH/desktop-binary matrix rows. All are now in phase 0.
The plan also explicitly prevents ordinary standing ticket grants inheriting
external attachment access.

## Validation boundary

The reviewer checked the current managed process teardown against the proposed
detach invariant; the original `session_send` semantics; owner-only authority;
the existing `ExecutorSessionPage` and session-sharing route; and whether the
plan could mislabel saved threads or unacknowledged channel events as live
control. It accepted the remaining experiments as explicit release gates.

No implementation, real delivery, native installation or rendered-flow test is
claimed by this review. A separate implementation review is required after
those gates are met.
