# Consent-to-disclose approvals in chat

Date: 2026-08-29
Status: plan

## Overview

An agent answering in a channel sometimes holds information that originated in a
**private context** — a DM, or another user's conversation the agent also serves.
When a *different* user asks something whose answer would reveal that private
information, the agent must not decide unilaterally. Today the only approval
machinery is the tool-execution gate (`worker/src/run/execute/tool-authorization.ts`,
`policyDecision.reason === 'approval_required'`, run status `waiting_approval`)
rendered on the standalone `/approvals` page — no in-chat surface, and nothing
that models *consent of the information owner*.

This plan adds a **consent-to-disclose approval** flow:

1. The **model judges** (never string-matched — AGENTS.md, "Natural-language
   intent is model-judged") that answering the current question would disclose
   information owned by a specific other user, and raises a disclosure-approval
   request instead of answering.
2. The info **owner is alerted**: a `UserAlert` row + web push — "This needs
   your approval — can I share X with \<asker\>?" (never containing the private
   content itself).
3. In the channel, an **Accept/Decline card** renders only for the owner
   (following the `RunStopContinue` metadata pattern). Everyone else sees a
   "Waiting for \<owner\>'s approval…" placeholder naming who was notified —
   never the private content.
4. On decision, a **group-visible system message** records the outcome
   ("\<Owner\> approved sharing this information" / "\<Owner\> declined to
   share this information"), the run resumes from its `waiting_approval`
   suspension, and realtime events flip every open client.

## Data model — reuse `ApprovalRequest`, extend; add one `UserAlertKind`

**Decision: no new table.** The `ApprovalRequest` model
(`api/prisma/schema.prisma` ~line 3513) already carries everything the flow
needs: `organizationId`, `channelId`, `taskId`, `runId`, `agentId`,
`requesterId` (the asker), `action`, `reason`, `context` (Json), `status`,
`resolverId`/`resolvedAt`/`resolution`, and `continuationToken` (the resume
handle the `waiting_approval` gate already uses). A second approval table would
be exactly the fork AGENTS.md rule-zero forbids; the `/approvals` page stays the
index over one table.

Additive migration (never edit a committed migration folder):

- `ApprovalRequest.ownerId String? @map("owner_id") @db.Uuid` + relation to
  `User`. `NULL` for existing tool-gate approvals; non-null for
  consent-to-disclose. This is the entitlement key — the person whose private
  context is at stake, distinct from `requesterId` (the asker) and from
  `requiredApproverRole` (role-gated tool approvals).
- `ApprovalRequest.messageId String? @map("message_id") @db.Uuid` — the chat
  message carrying the Accept/Decline card, so realtime `message.updated`
  reconciliation and the card's disabled-after-acting state can join
  request ↔ message in both directions without a scan.
- New `action` discriminator value used conventionally: consent requests are
  created with `action = 'disclose_information'`. No enum exists on `action`
  (it is a free `String`), so no enum migration is needed; the value is
  introduced in one constant in `@nessie/schemas` and imported by api + worker.
- `UserAlertKind` gains `approval_requested` (enum at
  `api/prisma/schema.prisma` ~line 1470; the model comment already anticipates
  "approval nudges, needs-action items"). The alert row links the request via
  `channelId` + `messageId` + a deterministic `eventKey`
  (`disclosure-approval:<approvalRequestId>`) so retries do not double-alert.

The private content itself is **never** persisted on the request. `context`
carries only a model-written, share-safe *summary* of what would be disclosed
(e.g. "your project-budget figure from our DM"), plus `askerId`/`ownerId`
echoes for presenter convenience. The placeholder view for non-owners renders
from these safe fields only.

## Linkage: channel / thread / message / owner / asker

- `channelId`, `taskId` (thread), `runId`, `agentId`, `requesterId` (asker):
  set at creation from the run context — the same fields the tool-gate already
  populates.
- `ownerId`: the user whose private context the model identified. The model
  names the owner by picking from structured facts — channel membership and the
  DM participants visible to the agent — never from free text; the worker
  validates the id is a real `OrganizationMember` of the run's organization
  before creating the request and refuses in words otherwise.
- `messageId`: the card message, created in the same transaction as the
  `ApprovalRequest` row (see "Worker hook"), so the pair is atomic — no
  orphan cards, no cardless requests.

## The model-judged trigger point

The trigger is a **tool the model calls**, not code that inspects messages.
Per AGENTS.md, detecting that an answer would disclose private information is
the model's job; deterministic code acts only on structural facts (who owns
the context, who is asking, run invariants).

- New builtin tool `request_disclosure_approval` (registered alongside the
  provisioning builtins; schema in `@nessie/schemas`, dispatch in the worker).
  Arguments: `ownerUserId`, `summary` (share-safe description of what would be
  shared), `reason`. The tool is available whenever the run's agent holds
  cross-context history (system prompt states this plainly).
- Dispatch lands in `worker/src/run/execute/tool-authorization.ts`'s single
  gate: `authorizeToolExecution` treats `request_disclosure_approval` as an
  approval-raising action. On invocation the worker, in **one transaction**:
  1. creates the `ApprovalRequest` (`action: 'disclose_information'`,
     `status: pending`, `ownerId`, `requesterId` = the message author,
     `continuationToken` minted exactly as the existing gate mints it);
  2. creates the **card message** (agent-authored, type system/action-card,
     `metadata.disclosureApproval = { approvalRequestId, ownerId, askerId,
     status: 'pending' }` — the `cancel-stop.ts` `metadata.runStop` pattern);
  3. creates the owner `UserAlert` (`kind: approval_requested`, `eventKey`
     deterministic);
  4. flips the run to `waiting_approval` — reusing the existing suspension
     path, so resume/expiry/cancellation (`api/src/services/runs.ts`
     `requestRunCancellation` already handles `waiting_approval`) come free.
- The tool result returned to the model is a structured acknowledgement
  ("approval requested from \<owner\>; run suspended"), never the verdict —
  the verdict arrives after resume.

## The owner-only Accept/Decline card

Reuse-not-fork: this is `admin/src/components/features/channels/RunStopContinue.tsx`
generalised, not a sibling look-alike (AGENTS.md rule 4 — one control,
parameterised). Extract the metadata-gated inline action-button pattern into
the card component and add:

- New `DisclosureApprovalCard` reading `metadata.disclosureApproval` through a
  zod schema (same `readRunStop` shape), rendered by the message feed where
  `RunStopContinue` is rendered today.
- The card calls `POST /api/approvals/:approvalId/resolve`
  (`api/src/routes/approvals.ts`) — **the existing resolve route**, extended:
  when `action === 'disclose_information'`, the caller must be
  `approval.ownerId` (structural entitlement — the live
  `OrganizationMember`/user id comparison, no role inference). Non-owners get
  the same refusal wording the route already uses for unauthorized resolves.
- **Rendering entitlement is client-cosmetic, server-enforced**: the card's
  buttons render enabled only when the session user id ===
  `metadata.disclosureApproval.ownerId`; other members see the disabled/
  waiting treatment (below). The server check is the real gate.
- After resolution, `message.updated` carries `status: 'approved' | 'declined'`
  in the metadata and every client disables the card (the `RunStopContinue`
  "already continued" toast precedent: every refusal is authored by the API and
  repeated verbatim).

## The pending "waiting + notified" view for others

While `status === 'pending'` and the viewer is not the owner, the card renders:
"Waiting for \<owner display name\>'s approval…" plus "Notified \<owner\> via
alerts and push." It shows the `summary` (model-written, share-safe) and the
asker; it never shows source-channel excerpts, quoted private text, or the
owner's private-context content. The agent's own run output for the suspended
turn is withheld from the feed exactly as `waiting_approval` runs already are.

## The group-visible outcome message

On resolve (both outcomes), the API — inside the same transaction as the
`ApprovalRequest` status flip, following the `requestRunCancellation`
transaction pattern in `api/src/services/runs.ts`:

1. updates the card message metadata to the terminal `status`;
2. inserts a channel system message: "\<Owner\> approved sharing this
   information" / "\<Owner\> declined to share this information"
   (agent-attributed system notice, no private content — the *fact* of consent,
   not the consented material);
3. resumes the run through the existing `waiting_approval` continuation path:
   on approve, the model is told consent was granted and answers; on decline,
   it is told consent was refused and refuses in words.

## Alert + push to the owner

- `UserAlert` row (`kind: approval_requested`, `channelId`, `messageId`,
  `actorAgentId` = the requesting agent, `eventKey` deterministic) written in
  the worker's creation transaction — the pipeline in
  `api/src/services/alerts.ts` then serves it through `GET /api/alerts` and the
  admin top-bar bell with **zero new alert plumbing**.
- Realtime `alert.created` fires to the owner's user scope as today.
- Web push rides the existing pipeline (`docs/web-push.md`): muted channels
  suppress push but never the durable row, per the `UserAlert` contract. The
  push body is the share-safe summary only.

## Realtime updates

- Card state: `message.updated` on the channel scope (existing message-create
  /update fan-out) — flips pending → approved/declined on every open client.
- Outcome notice: `message.new` on the channel scope.
- Owner notification: `alert.created` on the user scope.
- Run state: the existing `approval.resolved` publish in
  `api/src/routes/approvals.ts` (~line 91) is reused unchanged — it already
  targets the channel scope when `channelId` is present.

## Entitlement

- Only `ownerId` may resolve a `disclose_information` request — enforced
  server-side in the resolve service, comparing against the caller's user id
  (structural fact), independent of `requiredApproverRole`.
- Scoping follows AGENTS.md rule 2: the request is visible to channel members
  by channel entitlement, never narrowed by ambient session project/team.
- The owner-only button enablement in the client is a rendering convenience;
  the server refusal is authoritative.

## Disposition of the standalone `/approvals` page

**Keep as the index, fold the new kind in.** `admin/src/pages/ApprovalsPage.tsx`
continues to list every `ApprovalRequest`; consent-to-disclose rows appear with
their `action`, owner, asker, and a deep link into the channel message (the
card is the primary doorway; the page is the owning surface for audit and for
owners who missed the alert — AGENTS.md rule 1: home + doorway). Owners can
also resolve from the page through the same resolve route. No second page.

## Reuse-not-fork summary

| Need | Reused mechanism | Not built |
| --- | --- | --- |
| Suspension/resume | `waiting_approval` + `continuationToken` (tool-authorization.ts, runs.ts) | no new run state |
| In-chat action card | `RunStopContinue` metadata-gated button pattern | no parallel card system |
| Card payload | `cancel-stop.ts` `metadata.runStop` stamping pattern | no new message column |
| Owner notification | `UserAlert` + `GET /api/alerts` + bell + push | no new alert pipeline |
| Decision persistence | `ApprovalRequest` + existing resolve route/service | no new table |
| Broadcast | existing `message.new`/`message.updated`/`alert.created`/`approval.resolved` | no new event types |
| Cancellation of a pending request | `requestRunCancellation` (already covers `waiting_approval`) | no bespoke cancel |

## Phased task list

1. **Schema** — additive migration: `ApprovalRequest.ownerId`,
   `ApprovalRequest.messageId`, `UserAlertKind.approval_requested`; the
   `'disclose_information'` action constant in `@nessie/schemas`. Update the
   `UserAlert` model comment's kind list. (New migration folder only —
   `pnpm lint:migrations` must pass.)
2. **API** — extend the resolve service/route
   (`api/src/routes/approvals.ts`, `api/src/services/approvals.ts`): owner-only
   entitlement for `disclose_information`; transactional outcome message
   insert + card-metadata update; include `ownerId`/`summary`/message link in
   the presenter so `ApprovalsPage` can render the new kind. Keep the
   `approval.resolved` publish.
3. **Worker hook** — `request_disclosure_approval` builtin: schema, prompt
   availability, dispatch through `authorizeToolExecution`; the single
   creation transaction (request + card message + alert + `waiting_approval`
   flip); resume path injects the verdict. Rebuild `@nessie/worker` (dev API
   embeds built `dist`).
4. **Chat card** — extract/generalise the `RunStopContinue` pattern;
   `DisclosureApprovalCard` with owner-enabled buttons, disabled-after-acting,
   non-owner waiting view; wire into the message feed; deep link from
   `ApprovalsPage` rows.
5. **Alerts** — confirm `api/src/services/alerts.ts` list/read paths handle
   `approval_requested` (the `visibleUserAlertWhere` scope is generic; verify
   mark-read kinds need no change); push copy via the existing web-push
   pipeline.
6. **Realtime** — verify `message.updated`/`message.new`/`alert.created`
   fan-out covers the new writes; add nothing new unless a gap appears.
7. **Tests** — worker: creation transaction + resume on approve/decline
   (mock-LLM scenario where the model calls the tool); api: owner-only resolve
   entitlement (non-owner refusal), transaction atomicity, alert row +
   `eventKey` idempotency; admin: card renders owner-enabled/other-waiting/
   disabled-after-acting (Playwright, headless, per repo verification rules);
   fixtures include non-English/misspelled asker phrasing to prove the trigger
   is model-judged, never keyword-matched. DB suites follow the shared-database
   rules (seed-scoped cleanup, no global counts, `DATABASE_URL` exported via
   Turbo).
