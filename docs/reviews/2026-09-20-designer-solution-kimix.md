# Agent Designer solution review — Kimix

Reviewed on 2026-09-20 using Kimix, model `k3`, provider `kimi`, in a separate
read-only worktree. Reviewed commit: `b3ae7a40d63339754a4917644faa720c575691ac`;
base: `d32539e9739347d645c7387124af09dfcbddacda`.
Session: `01a0bf70-8e9a-7b33-b5be-d203a631f19a`.

The reviewer produced the complete verdict below. Its CLI wrapper subsequently
reported a context-window failure; this is a captured static review, not a
successful automated validation job. Subsequent changes require a delta review.

## Reviewer report (verbatim)

Review complete. I traced the full diff (78 files, +3653/−2338) against `d32539e9`, read the plan, the prior diagnosis, and the routed standards (tool-categories, personal-assistant-tools, local-ollama-agents, agent-email, tech-and-run-budgets, team-model), and independently verified each mechanism in code rather than relying on the docs' conclusions.

**Verdict**

No must-fix findings. The implementation matches the brief and correctly avoids both P0 traps the diagnosis flagged. The defects below are low-severity polish/parity items; the material limitations are listed separately. I did not re-run suites (read-only review); runtime proof is the in-progress full worker/API run and browser rerun, per the handoff.

**Verified Correct**
- `tool_spec` dual-gate repair: `unregisteredToolNames` vs `externalContentToolNames` split (`worker/src/run/execute/tool-authorization.ts:72-75`, both arms in `worker/src/run/execute/agent-loop.ts:125` and `:268`) keeps the registry bypass while exempting schema discovery from `blocksPrivateConversationWrite`; content sinks stay gated, and `tool-authorization-proof.test.ts:196` pins exactly this.
- Shared-service parity is real, not forked: policy registry, DeepWater access/revocation/lock, plugin manifests moved to `@nessie/mcp-manage`; trigger lifecycle, delete, policy core to `@nessie/team-admin`; `api/src/services/*` are pure forwarders, and routes and Designer tools call the same functions, including the advisory lock, descriptor-fingerprint grant sync, bundle readiness and active-run revocation guard.
- Fresh authority: `resolveActingMember` re-reads membership per call (demotion test proves it), owner-only mirrors `requireOwner`, cross-org/private/unjoined-channel MCP instances denied, executor-sourced entries refused, target visibility scoped by `buildAgentVisibilityWhere` under the policy lock, canonical PAs reachable as targets. `localInferenceBindingId` goes through `activateConsentedLocalInferenceBinding` (consent enforced server-side, no cloud fallback on unbind); mailbox tools keep their per-`(connection, agent)` guards.
- No-cap contract: OpenAI/Codex/Ollama omit the field; Kimi sends advertised catalogue capacity (`context_length` fallback) and fails closed if unreachable; no adapter restores a silent default. Communication guidance is in the shared prompt and Designer blueprint, not a token rule.
- Recovery: bounded (one regeneration), same-run identity, truncated tool frames never dispatched and dropped from the transcript, no replay (pinned by `agentic-loop.test.ts`), repeated length classified `provider_output_limit` → truthful failure, never `token_limit`; crash state carries `outputFinalizationNoTools` with rolling-deploy-safe legacy fields.
- Docs/standards/AGENTS/CLAUDE signposts, catalogue and blueprint wording updated in the same change; browser eval asserts DB state, no `run.budget_exhausted` event, no "Continue this run" copy, and one execution per mutation.

**Findings (all low)**
- `worker/src/run/pa-tools/agent-access.ts:56` — `publishAgentUpdated` publishes `agent.updated` to the agent scope only, while the API route (`api/src/routes/mcp/tools.ts:311`) publishes organization + agent. The admin shell subscribes at org scope (`admin/src/facades/agents/realtime.ts:60`), so an open Tools screen won't live-invalidate when Designer grants/revokes. `runAgentDeleteTool` in the same change does publish both scopes, so this is an inconsistency, not a design. Fix: add `{ kind: 'organization', organizationId }` to the scopes. Trigger update/delete tools have the same agent-only pattern, but there the API route publishes nothing, so the worker is strictly better.
- `worker/src/run/inference-stage.ts:202-205` — stale comment: `maxOutputTokensOverride` no longer "raises the ceiling above `modelConfig.maxTokens`"; nothing in the worker consumes that config anymore. Related drift: `packages/config/src/config-schema.ts:79-81` claims `maxTokens` is "used by explicitly bounded operational calls only", but the bounded callers (memory extraction, orchestrator router, API summaries) use their own constants, and `resolveComposeOutputTokens` (`worker/src/run/execute/document-cancel-poll.ts:14`) is now dead. Fix: delete or re-scope the knob and comment.
- `admin/e2e/designer-capabilities/run.mjs` — the `recoveries` counter is recorded to `verification.json` but never asserted. The recovery is still proven indirectly (the `GRANTED_ANSWER` text is only reachable through the no-tools utility lane matching the finalization instruction, plus the consumed-2,048-invocation assertion), so this is not false-green; one `assert.equal(recoveries, 1)` would make it explicit.

**Material Limitations (by design or accepted risk, not bugs)**
- Utility lanes (compaction, checkpoint notes, send-boundary judge, watch status) and delegate sub-agent turns also lost the 2,048 operational bound — `runUtility` passes no cap. This exceeds the diagnosis's "raise only the main turn" caution. Spend is still metered and wind-down enforced after each inference, so the exposure is cost-of-one-call, not unbounded runs; worth a deliberate sentence in `tech-and-run-budgets.md` either way.
- Kimi capability discovery fetches `/v1/models` once per stage execution (the capability cache is per-service-instance, and a service is built per stage), adding a 10 s-timeout network dependency to every Kimi turn; a catalogue outage throws before `onInferenceAttempt` and surfaces through the generic `unknown` classification, losing the specific "provider catalogue" message. Ledger-routed Kimi with no ledger cap entry fails closed the same way.
- `setDeepWaterAgentAccess` takes no `actorUserId`, so the worker tool's target-visibility check happens before the transition lock, not inside it (TOCTOU window). Owner-only and matches the API route exactly — noted for hardening, not a defect against parity.
- Audit emission from worker tools is best-effort (failure logged, not surfaced) and denial paths (non-owner attempts) are not audited — identical posture to the API routes.


## Resolution and newer evidence

- The realtime finding is corrected in `780159341`: protected-access updates
  publish the same minimal event to organization and agent scopes as the API.
  The real-database handler regression asserts the exact scopes.
- The browser-counter observation referred to the reviewed revision. The newer
  pre-action reasoning truncation evaluation explicitly asserts one truncated
  chat invocation, zero premature no-tools finalizations, all four expected tool
  calls exactly once, and persisted grants/voice. It failed before the recovery
  fix and passed afterward against the built admin preview on desktop and phone.
- The standards explicitly document removal of the shared utility/delegate
  blanket output cap and the last-call overshoot characteristic of run budgets.
  This follows the user's system-prompt communication requirement.
- Full local suites passed: worker 1,423; API 1,980 (four skipped); runtime 411;
  executor 361 (four skipped). Full workspace typecheck and lint passed. The
  reasoning-only continuation adds focused loop/crash recovery regressions.
  These are local checks, separate from final CI and production verification.
