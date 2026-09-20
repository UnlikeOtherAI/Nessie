# Review reconciliation

Part of [Local Ollama agents](overview.md). This document reconciles Sol's
[adversarial review](adversarial-review.md). The review correctly rejected
design commit `6c6c9632f`; this file and the amended chapters are the binding
implementation contract. Astra was not rerun.

## Release shape after review

V1 is deliberately owner-host-only. An organisation administrator may enable
local agents for a person or team, but that setting only permits each enabled
member to connect their own person-owned agent to their own computer. It never
offers a computer to teammates. Team-owned, system-managed and global agents,
team host pools and cross-person hosts are outside V1.

This keeps the requested team policy scope while making the processor and agent
authority principal the same stable UOA subject. It removes the missing team-
offer surface and prevents a hostile teammate's model from borrowing another
person's agent/tool authority. It does not weaken prompt-recipient disclosure:
every source still needs complete provenance and the owner/custodian must be
entitled to it.

## Blocker resolutions

| Review finding | Binding resolution | Release proof |
| --- | --- | --- |
| Disclosure evidence fails open | Add a closed `ProvenancedProviderInput`. Every ordered prompt component requires a source-adapter coverage token. Missing/empty coverage returns `unclassified_input` before payload persistence. `ConsumedSourceSink` remains reply evidence, not host-dispatch proof. | Deliberately omit one adapter token; assert zero attempt payload/frame bytes. |
| Two activation authorities | Native confirmation only creates `consented_pending_activation`. Agent Designer Save is the sole activation commit and locks/compares agent, form, host, model, policy and consent revisions. | Race Save/confirm/cancel/expiry/policy disable on two replicas; exactly one exact state wins and the prior lane otherwise remains. |
| Local cannot exclude Ollama Cloud | Require empty official Ollama `remote_host` and `remote_model`, a non-empty manifest digest and local model metadata at list/show; reject remote markers in every result frame. Unknown is ineligible. Names are irrelevant. | Real cloud entry is visible through loopback, rejected, and produces no accepted output; outbound observation validates the fixture. |
| Team host has no offer/withdraw control | Remove team/cross-person hosting from V1. No `offeredTeamId`, offer control or team host inventory exists. | API tests prove another subject and team-owned agent cannot list, prepare or use the host. |
| Team host can steer another person's tools | Owner subject must equal host custodian at prepare, Save, dispatch and each tool round. Normal schema, authorization and approval gates still treat output as hostile. | Signed host with a different subject and malicious calls across every tool category is rejected before side effects. |

## High-severity resolutions

1. **UOA outage:** add `allowed | denied | unavailable`. Only authoritative
   denial revokes. Unavailable refuses new disclosure/dispatch, retains the
   binding as unavailable, renders Unknown and retries with bounded backoff; no
   stale cache can turn it allowed.
2. **Native boundary:** commands require the `main` window and configured
   TLS-verified origin. Consent receives only an opaque id, fetches canonical
   signed display data natively, and binds origin, account, organisation,
   custodian, machine key and challenge. Origin change signs out and rebinds.
3. **Key rotation:** repair/re-pair advances authorization and connection
   epochs, fences attempts/receipts and makes all bindings `needs_rebinding`.
4. **Setting race:** `LocalInferencePolicyVersion` is incremented under the
   same organisation advisory lock used by protected writes, prepare, Save and
   revocation. Save compares the prepared version and recomputed cascade.
5. **Alerts:** deploy typed reader/resource projection before writers. Routes
   reauthorize; recipients are exact owner/custodian or live policy admin for
   their actionable failure; payloads contain no host/model/private names.
6. **False doorways:** add and consume `designerSection=model`; implement a
   real authorized conversation restart action that creates a new run instead
   of replaying an accepted attempt. Both go through navigation framework.
7. **Endpoint race:** deterministic saved/IPv4/IPv6 order; if distinct daemons
   answer, the custodian explicitly selects a canonical socket. Revalidate it
   immediately before consent and dispatch.
8. **Invented roles:** remove “host manager” and “support-authorised admin”. V1
   host details belong only to the owner/custodian. Policy editing uses live
   organisation owner/admin authority; support has no implicit access.
9. **Receipt storage:** result replay is separately capped, encrypted by a
   non-exportable platform key, owner-only, excluded from logs/dumps/bundles,
   deleted after server ACK and hard-expired after one hour. Failure is closed.
10. **Rollback:** reader-first expansion, old-writer fences and deployment
    capability gates precede writes. A downgrade leaves local agents explicitly
    unavailable and cannot reinterpret or clear their pins.

## Medium and low resolutions

- `numCtx` is host-owned and has no V1 UI control. The effective value is
  `min(8192, reportedCap, runLimit)`; changing this contract requires reconsent.
- Server revocation and local key deletion are separate controls/CLI verbs with
  truthful partial results.
- Inventory is outside heartbeats, cursor-paginated, at most 100 entries and
  256 KiB aggregate decoded JSON per page; every string/array is bounded and
  normalized.
- Capability smoke exposes only a synthetic no-op tool schema, discards output
  and never reaches authorization or execution.
- Delegation pins the child `Run`, never the durable child `Agent`; later runs
  cannot inherit the host.
- Digests/capabilities are labelled “reported by this computer” and “last
  tested”, not attested or verified code provenance.
- WSL/VM endpoints are unsupported unless already presented as a literal host-
  loopback forward. Nessie does not create or recommend LAN exposure.
- Alert recipients are defined per transition in the transport chapter.
- Server time and expiry decide presence; client clocks are cosmetic only.
- Every host-reported string is normalized, escaped and length-capped before
  storage, logs, alerts, support copy or display.

## Element audit reconciliation

The amended [experience inventory](experience.md) is exhaustive, not a sample.
Each native, web and CLI control is a separate row with its audience, decision,
truth source and omission cost. Reconciliation made these product changes:

- removed cross-person/team-offer controls and the editor context-limit field;
- made Save the sole activation control and native consent an approval only;
- split Retry from inventory Refresh;
- split server Revoke from local key deletion;
- split hosting enablement from per-binding consent;
- added the conditional conflicting-daemon selector;
- split the Linux/headless CLI into status, discover, enable/disable, pending,
  consent/reject, pause/resume and revoke/forget-local decisions;
- restricted support details to the owner/custodian and removed invented roles;
- added a real run Restart element and an Unknown availability state.

Implementation may remove an element when its branch is not shipped. It may not
combine decisions behind ambiguous copy or add any visible/CLI datum without a
new inventory row naming the decision it enables. The browser evaluation maps
every rendered element back to this table.

## Stop-ship gate

Implementation is not releasable until all of the following are demonstrated:

- closed prompt provenance refuses an intentionally unclassified component;
- Save-only activation survives all confirmation/policy races;
- a real Ollama cloud model is rejected structurally and by network observation;
- every host/agent path enforces identical owner and custodian subjects;
- UOA denial and unavailability have distinct durable transitions;
- native main-window/origin/account/session binding rejects document windows,
  stale sessions and origin changes;
- key rotation and policy-version changes fence attempts and consent;
- typed alerts authorize readers and open real repair/restart routes;
- conflicting loopback daemons never resolve by response timing;
- rolling upgrade and downgrade never route a local pin to cloud/another host;
- protected result receipts pass crash-before-ACK and expiry tests;
- headless Linux can inspect and decide every pending action safely;
- every experience inventory row is exercised or deliberately absent.

