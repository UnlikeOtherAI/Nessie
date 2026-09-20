# Local Ollama agents with device presence

Status: implementation-ready proposal, reconciled after adversarial review on
2026-09-20. No runtime behaviour is implemented by this documentation change.
Code inspected at `5ce41f8a0`; the review applies to design commit `6c6c9632f`.

An existing Nessie agent can use an installed Ollama model on a person's
computer. The computer connects either through its paired executor or directly
from the running Nessie desktop application on macOS, Windows and Linux. The
agent remains the same agent, in the same conversations, with the same owner,
avatar, tools and permissions. Its online/offline indicator tells a colleague
whether that local agent can currently take work.

An organisation administrator can enable the capability for one person or one
team. Enabling permits setup; it does not start software, share a computer,
select a model, transfer ownership or send a conversation to that computer.
Those are explicit choices at the existing agent model picker and the host's
local consent surface.

## Table of Contents

- [Authority and storage](authority-and-storage.md): scope, entitlement,
  ownership, data model and the confidentiality boundary.
- [Transport and execution](transport-and-execution.md): both host modes,
  discovery, pairing, protocol, presence, routing, failure and cancellation.
- [Experience and element inventory](experience.md): automatic setup,
  consent, states, doorways and the decision justified by every UI element.
- [Delivery and verification](delivery.md): exact integration points, phased
  work, compatibility, durable evaluations, release gates and open decisions.
- [Adversarial review](adversarial-review.md): architecture, security, product,
  and complete element-inventory findings against this proposal.
- [Review reconciliation](review-reconciliation.md): the binding resolutions
  for every blocker and stop-ship item. The reconciled chapters, not the
  rejected pre-review snapshot, are the implementation contract.

## Goals and release boundary

The first coherent release includes both connection modes on all three desktop
platforms, structurally proven local already-installed Ollama chat models,
explicit user/team enablement, one selected owner-controlled host and model per
existing person-owned agent, native tool-call round trips through the existing
server worker, bounded streaming, offline recovery, and the complete
setup/status/repair experience. A plain web browser may configure its owner's
already paired executor but cannot scan its own host.

Not included: an autonomous local copy of Nessie, offline chat synchronization,
running a second agent loop on the host, team-owned agents, another person's
host, model downloads/updates/deletion, Ollama installation, GPU tuning, LAN
scanning, a general HTTP tunnel, cloud fallback, voice/media inference,
embeddings, or localising server security judges. Team enablement means members
may configure their own agents and computers for work in that team; it never
offers one member's computer to another. No new user account, organisation,
team, agent kind or public directory is created. Sandboxed Mac App Store
support is a separate compatibility gate; the signed direct-distribution
desktop app is the initial macOS target.

The main worker still owns context assembly, tools, approvals, disclosure,
checkpoints and messages. The host runs one bounded inference call at a time.
It never receives a UOA assertion, vendor credential, tool execution token or
authority to call a Nessie tool. A returned tool call is untrusted model output
and enters `authorizeToolCall` exactly as a cloud model's output does.

## Decisions that define the feature

1. **Local inference is an explicit third generative lane.** Main answers,
   compaction, checkpoint notes and bounded model delegates stay on the pinned
   local binding. The boot-time engagement model, security judges, embeddings
   and post-run memory remain on their existing deployment lanes. Setup says
   this plainly; this is not an all-data-on-device claim.
2. **No cloud fallback in this release.** Offline means waiting within the
   stated bound, then a recoverable failed run. Neither an admin preference nor
   the ordinary routing profile may silently send that run to Ledger or a
   subscription. An authorised editor can explicitly select a cloud model for
   future runs; restarting then creates a new run under the new selection.
3. **A host is a processor and a disclosure recipient.** V1 permits only the
   agent owner's own host; team policy never offers a teammate's laptop. Every
   assembled prompt is made from provenance-bearing components and passes the
   fail-closed recipient checks in the authority chapter.
4. **Presence and activity are independent.** `Agent.status` still means idle,
   thinking, executing, waiting or error. A separate, server-derived availability
   answers online/offline. Human `UserPresence` and away/do-not-disturb state
   are untouched. A busy, reachable model is online and busy, not offline.
5. **Detection is read-only and automatic after local feature consent.** The
   bridge tries the known loopback endpoints and lists installed models. It
   never runs an discovered executable, changes `OLLAMA_HOST`, scans the LAN,
   installs a service or downloads weights. An administrator cannot turn local
   detection on remotely without the machine user's consent.
6. **Locality is structural, not a label.** A selectable model must be returned
   by the loopback daemon with empty `remote_host` and `remote_model`, a local
   manifest digest, and local model metadata in both list/show observations.
   The same fields are checked on every chat result. Unknown locality and any
   remote marker are ineligible; names such as `-cloud` are never the predicate.
7. **One implementation per responsibility.** Both transports use one wire
   contract, one authority service, one provider adapter, one availability
   projection and one reusable setup/status component. Platform shell code
   supplies lifecycle, secure key storage and narrow native networking only.

## Binding review resolutions

The review's pre-reconciliation verdict was **REJECT**. Implementation may
start only from the reconciled contract. Its binding decisions are:

1. Provider input is a closed, provenance-bearing projection; an unclassified
   component makes local dispatch impossible.
2. Native confirmation approves an inactive exact binding. The existing Agent
   Designer **Save** is the only action that can activate it, under one policy
   and form compare-and-swap transaction.
3. The model-level local predicate uses official Ollama remote markers and
   local manifest evidence at discovery, pre-dispatch and response time, with
   a real cloud fixture and outbound-network assertion in the release gate.
4. V1 is owner-host-only. Team enablement is policy scope, not host sharing.
   Team-owned/system-managed/global agents and cross-person hosts are excluded.
5. Because the custodian and agent owner are the same stable subject, the
   model cannot borrow somebody else's agent authority. Model tool output is
   still hostile, schema-validated, authorized and approval-gated normally.

The remaining high/medium/low corrections are specified in
[review reconciliation](review-reconciliation.md) and incorporated into the
authority, transport, experience and delivery chapters.

## Relationship to the existing local-offload proposal

The [2026-09-18 offload proposal](../2026-09-18-local-llm-offload/overview.md)
describes a frontier agent delegating a small host-bound task through
`delegate_local`. This proposal adds the explicitly requested **whole-agent
model selection**. Its rejection of an agent lane is superseded only for that
new opt-in mode; its bounded delegation mode and privacy guarantees remain.

Two primitives have already landed: `packages/schemas/src/local-inference.ts`
contains a curated, digest-pinned Gemma catalogue, and
`executor/src/ollama-client.ts` detects Ollama and imports verified blobs.
There is no full-agent local binding, daemon inference delivery, or agent
availability implementation at the inspected SHA. The older overview's blanket
"nothing is built" is therefore narrowed in this change.

Reuse the Ollama transport after extracting its non-import functionality into
a genuine shared module. Keep the curated download catalogue intact; an
already-installed model is a separate *observed inventory entry*, never a new
entry in that trusted download catalogue. A tag named `latest` is acceptable
as a person's local label, but selection pins the observed manifest digest.
It cannot mean "silently follow future weights".

Use one future billing discriminator `local_device` for direct desktop and
executor inference, plus a typed host reference. The earlier proposed
`local_executor` enum has not landed and should not be introduced in parallel.
Offload can use the same discriminator when it is implemented. Never turn
`local.delegate` into a general inference proxy or represent generative calls
as fake `ToolCall` records to fit `ExecutorCommand`'s required foreign key.

## Grounding and standards

Existing hooks are `assertAgentModelSelection`,
`listAgentModelOptionsForUser`, `resolveStageProviderConfig`, `executeStage`,
`resolveRunSubscriptionBinding`, `createInferenceService`,
`resolveLiveEntitlements`, `resolveScopedSetting`, and the executor's signed
challenge/epoch/receipt design. The main desktop app is a Tauri hosted-admin
shell with native commands, not a standalone worker.

This design follows [architecture](../../architecture.md),
[provider/frontend boundaries](../../provider-system-and-frontend-architecture.md),
[navigation](../../navigation/overview.md),
[agent ownership](../../standards/agent-ownership.md),
[global agents](../../standards/global-agents.md),
[team authority](../../standards/team-model.md),
[scoped settings](../../standards/scoped-settings.md),
[model availability](../../standards/inference-model-availability.md),
[personal subscriptions](../../standards/personal-model-subscriptions.md),
[executor-local MCP](../../standards/executor-local-mcp.md),
[disclosure](../../standards/disclosure-boundaries.md),
[egress](../../standards/egress.md),
[run budgets](../../standards/tech-and-run-budgets.md),
[capability health](../../standards/capability-health-alerts.md),
[design system](../../standards/design-system.md), and
[horizontal scaling](../../standards/horizontal-scaling/overview.md).
Implementation must update their affected contracts when behaviour lands;
this proposal does not claim those standards already describe a local lane.

## Evidence and limitations

Read-only checks on the user's Windows machine on 2026-09-20 found Ollama
`0.34.1` at `http://127.0.0.1:11434`, eleven installed tags, and
`gemma4:12b` reporting completion and native tool support. No model was loaded,
downloaded, modified or prompted. `/api/status` reported cloud features enabled,
which is why locality is decided per model rather than inferred from loopback or
a global preference; the observed local entries had no remote markers. These
checks prove discovery availability, not the required real cloud rejection
fixture, inference quality, speed or cross-platform correctness.

The native [Ollama chat API](https://docs.ollama.com/api/chat) supplies tool
calls, streaming and token counts; the
[model list API](https://docs.ollama.com/api/tags) supplies names and manifest
digests. Ollama's official
[OpenAPI contract](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
defines `remote_host` and `remote_model`, while its
[cloud guide](https://docs.ollama.com/cloud) confirms that cloud models can be
invoked through the loopback API. Context and keep-alive controls are documented in the
[Ollama FAQ](https://docs.ollama.com/faq). Nessie's protocol limits below are
proposed product defaults, not claims about universal Ollama limits.
