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
3. An **owner-only decision card** renders for the owner (following the
   `RunStopContinue` metadata pattern) with a **"See the answer first"** option
   that reveals the drafted answer before deciding, then **Share it** /
   **Keep it private**. Everyone else sees an **anonymous** placeholder —
   "Waiting for approval to share information" — that names **no one**: not the
   owner, not who was notified, never the private content.
4. On decision the run resumes from its `waiting_approval` suspension and
   realtime flips every client. The group message is **anonymous and passive**:
   on decline, "Sharing this information was declined"; on approve, the agent
   simply posts the answer (the answer *is* the outcome — no separate "so-and-so
   approved" notice). No participant's name is ever attached to the act of
   approving or declining.

**Guiding principle (per direction): the safest, easiest, most helpful
experience for the whole team.** Bystanders never learn *who* holds a secret or
*that* a specific person was asked — anonymity protects the owner; the owner
sees exactly what would be shared before consenting; nothing strands the asker
or the room. Every ambiguous choice below resolves toward that.

## Data model — reuse `ApprovalRequest`, extend; add one `UserAlertKind`

**Decision: no new table.** The `ApprovalRequest` model
(`api/prisma/schema.prisma` ~line 3513) already carries everything the flow
needs: `organizationId`, `channelId`, `taskId`, `runId`, `agentId`,
`requesterId` (the asker), `action`, `reason`, `context` (Json), `status`,
`resolverId`/`resolvedAt`/`resolution`, and `continuationToken` (the resume
handle the `waiting_approval` gate already uses). A second approval table would
be exactly the fork AGENTS.md rule-zero forbids. The in-chat card renders every
`ApprovalRequest` — the new `disclose_information` request and the existing
tool-gate `approval_required` request alike — so the standalone `/approvals`
page is removed (see "Disposition" below), not kept as a second surface.

Additive migration (never edit a committed migration folder):

- `ApprovalRequest.ownerId String? @map("owner_id") @db.Uuid` + relation to
  `User`. `NULL` for existing tool-gate approvals; non-null for
  consent-to-disclose. This is the entitlement key — the person whose private
  context is at stake, distinct from `requesterId` (the asker) and from
  `requiredApproverRole` (role-gated tool approvals).
- `ApprovalRequest.messageId String? @map("message_id") @db.Uuid` — the chat
  message carrying the decision card, so realtime `message.updated`
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

## Self-disclosure is pre-approved — the owner asking about their own info

If the **asker is the owner** of the information — I ask an agent about
something I am privy to but others are not — no approval is needed: I already
have the right to my own private context. This is a **pre-approved** request,
so the agent answers directly and **no** `request_disclosure_approval` is
raised, **no** card, **no** alert, and **no** group-visible outcome message is
posted.

The pre-approval is **narrow by construction — that information, that request
only**, never a standing grant:

- The decision is per-answer and structural. The model still judges, per turn,
  what an answer would disclose and whose private context it belongs to (the
  `ownerUserId` it would name); the worker then checks the **structural fact**
  `askerUserId === ownerUserId` (the message author vs. the identified owner).
  Only when they are the **same person** is that particular answer auto-cleared.
  This is a user-id equality check on structural facts — allowed by AGENTS.md
  ("deterministic code may act only on structural facts"), not a content
  heuristic.
- **Nothing is persisted.** No `ApprovalRequest` row, no reusable "approved"
  flag, no scope grant. Because there is no stored approval, a *later* request —
  even by the same owner — for a *different* piece of private information, or
  the *same* information surfaced in a *different* case, is evaluated fresh and
  raises its own request if the asker is not that item's owner. Self-disclosure
  can never leak into a standing bypass others could ride.
- If a single answer would disclose information owned by **more than one**
  person, the asker being one owner pre-approves **only their own** slice; any
  slice owned by someone else still raises a `request_disclosure_approval` for
  that other owner. The agent answers with the owner's own material and withholds
  the rest pending approval.
- **Provenance, so the shortcut never surprises.** Because "my info" is not the
  same as "publish my info to this room", when the self-disclosure answer lands
  in a group channel the agent tags where it came from — e.g. "From our DM: …" —
  so the owner realises, in the moment, that private context just crossed into a
  shared room and can course-correct. The shortcut keeps its speed; the owner
  keeps their awareness.

## The owner's decision card — "See the answer first", then Share / Keep private

Reuse-not-fork, honestly scoped: `RunStopContinue.tsx` is a 79-line one-button
affordance, so we reuse its **conventions** — a zod-read metadata stamp, the
disabled-after-acting state, and API-authored refusal copy repeated verbatim —
by extracting a small shared **action-card primitive**, and build the two-role
card on top of it. This is the "extract now that a second real case exists"
reading of rule 4, not forcing a one-button control and a multi-state card into
one abstraction. (The existing `approval_required` tool-gate card is the third
case the same primitive serves — see "Disposition".)

The owner's card (owner-only view — it is their information, so this is safe):

- Shows the model's share-safe `summary` and a **"See the answer first"**
  control that reveals the **drafted answer** the agent would post if approved.
  This closes the "approve a label, not the contents" gap: the owner consents to
  what will actually be said. The draft is generated for the owner's eyes only
  and never leaves this card until approval.
- Two actions, labelled by **consequence, not verdict**: **Share it** and
  **Keep it private**.
- Calls `POST /api/approvals/:approvalId/resolve` (`api/src/routes/approvals.ts`)
  — **the existing resolve route**, extended: for `disclose_information` the
  caller must equal `approval.ownerId` (structural entitlement, live user-id
  comparison, no role inference, **not** channel membership — the owner may not
  be in the channel). Non-owners get the route's existing unauthorized-resolve
  refusal.
- **Rendering is client-cosmetic; the server is the gate.** Buttons enable only
  when the session user is the owner; everyone else sees the anonymous waiting
  view below.
- **Post-approval answer is scope-bound.** The agent is instructed that the
  approved answer must not exceed what the owner saw — the draft they approved
  *is* the commitment, so consent means what it said.
- After resolution, `message.updated` flips the card to its terminal state for
  every client, refusal copy authored by the API and repeated verbatim.

## The anonymous waiting view for everyone else

While pending and the viewer is not the owner, the card shows a single
anonymous line — **"Waiting for approval to share information"** — and nothing
else: no owner name, no "who was notified", no asker call-out, no `summary`, no
source excerpt. Naming a person tied to a pending secret can itself answer the
question ("who's leaving?" → "waiting for Sarah's approval"), so bystanders see
only that *some* answer is awaiting a private OK. The suspended turn's agent
output is withheld exactly as `waiting_approval` runs already are.

**Escape hatch — when even the anonymous wait would leak.** If revealing that an
approval is pending *at all* would answer the question, the model's judgement can
choose to decline quietly in-channel ("I can't help with that here") and still
alert the owner privately — no public waiting card. This is part of the same
model-judged decision, never a keyword rule.

## The group outcome — anonymous, and quiet on approve

On resolve, in the same transaction as the `ApprovalRequest` status flip
(following the `requestRunCancellation` pattern in `api/src/services/runs.ts`):

1. the card message metadata flips to the terminal `status`;
2. **approve:** no separate notice — the run resumes and the agent posts the
   answer, which is the only new message the room needs. **Decline:** an
   anonymous, passive system line — **"Sharing this information was declined"** —
   no name, no finger-pointing, so saying no carries no social tax that would
   pressure owners toward yes;
3. the run resumes through the existing `waiting_approval` continuation path: on
   approve the model answers within the approved scope; on decline it declines
   politely, and a recent decline visible in the transcript short-circuits a
   re-ask to a refusal **without re-pinging the owner** (anti-nag).

## Time, withdrawal, and not stranding anyone

A "Waiting…" that never ends is a broken experience for all three parties, so
the flow is bounded:

- **Expiry.** The request uses `ApprovalRequest.expiresAt` with a sensible
  default window (proposed 24h, deployment-tunable). On expiry the run resumes
  with a polite non-answer ("I wasn't able to get the OK to share that"), the
  card flips to a neutral **"This request expired"** (never "so-and-so ignored
  it"), and the owner's pending alert is cleared.
- **"Ask me later" / snooze.** Because a hard Decline is often not what an owner
  means in the moment, the owner's card offers a third, low-cost action that
  re-notifies them after a short delay and, in the meantime, resumes the run
  with "I'll check and follow up" rather than blocking. (If simpler to ship,
  land expiry + re-raise first and add snooze as a fast follow — but the
  design target is that no owner is forced into a binary yes/no under time
  pressure.)
- **The asker can withdraw.** The asker who triggered the question gets a
  **"Never mind / withdraw"** affordance that cancels the pending request, clears
  the owner's alert, and resumes with "the question was withdrawn" — reusing
  `requestRunCancellation`, which already handles a `waiting_approval` run. It is
  unkind to pin someone's name to an interrupt they can't take back.
- **One pending consent suspends only that thread's run**, never the agent in
  the whole channel — a room must not gridlock behind one unanswered ping.

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

**Remove it entirely — chat is the only surface.** Everything an approval needs
lives where the work is: the card is the doorway, and the run it gates is
already a conversation in a channel. So `admin/src/pages/ApprovalsPage.tsx`, its
`/approvals` route (`admin/src/router.tsx`), the "Approvals" admin nav item
(`AdminSidebarNav.tsx`, Governance group), and the page's data hooks are deleted
in this change — mirroring the Agents → Activity removal precedent.

**Consequence — the pre-existing tool-gate approvals must move to chat too, in
the same change.** Today `/approvals` is the *only* surface for the existing
`approval_required` tool-gate flow; deleting it without a replacement would
strand those approvals (Rule zero: a capability nobody can reach is unfinished).
So the in-chat card is built to render **both** kinds from `ApprovalRequest`
metadata — the new `disclose_information` request and the existing tool-gate
request — keyed off the request's `channelId`/`taskId`. This widens the change
but is the honest cost of removing the page: the card is one component
parameterised by the request's `action`, not two.

- **The resolve API stays; only the admin *page* goes.** `POST
  /api/approvals/:approvalId/resolve` and `approval.resolved` are unchanged and
  now serve only the in-chat card.
- **The owner may not be a member of the channel** — the archetypal case is
  info from a DM with someone who is not in the room. The card renders in the
  asker's channel, which that owner cannot open, and with the page removed there
  is no fallback surface. So the owner's **alert must open a focused,
  per-approval card view the owner can act on without channel membership** — the
  approval card as its own addressable surface reached from the alert/bell/push,
  *not* the deleted admin page and *not* requiring the owner to enter a channel
  they are not in. This is a hard requirement created by removing the page;
  phase 4 must build the standalone card view alongside the in-feed one (one
  component, two mounts), and the resolve route authorizes by `ownerId`, not by
  channel membership.
- **Approvals with no channel context** (should be none — a tool-gate approval
  is raised mid-run, and a run has a channel/thread — but `channelId` is
  nullable): the raise paths must attach the originating channel + card message
  for every approval, so none can exist without an in-chat home. Phase 1 audits
  the existing `approval_required` raise sites and adds the card there; any that
  genuinely cannot resolve a channel are called out as a blocker, not silently
  dropped.
- A migration/backfill note: any **already-pending** `ApprovalRequest` at deploy
  time won't have a `messageId`. Either backfill a card message for open rows, or
  accept that pre-existing pending approvals resolve only via API until they
  expire — decide during phase 1 (backfill preferred so nothing is stranded).

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

1. **Schema + raise-site audit** — additive migration: `ApprovalRequest.ownerId`,
   `ApprovalRequest.messageId`, `UserAlertKind.approval_requested`; the
   `'disclose_information'` action constant in `@nessie/schemas`. Update the
   `UserAlert` model comment's kind list. (New migration folder only —
   `pnpm lint:migrations` must pass.) **Audit every existing
   `approval_required` raise site** (grep `approval` in `worker/src`): each must
   attach the originating channel + a card message, so that once `/approvals` is
   gone no approval lacks an in-chat home. Flag any raise site that cannot
   resolve a channel as a blocker before proceeding.
2. **API** — extend the resolve service/route
   (`api/src/routes/approvals.ts`, `api/src/services/approvals.ts`): owner-only
   entitlement for `disclose_information`; transactional outcome message
   insert + card-metadata update. Keep the `approval.resolved` publish. (No
   presenter work for a page — the page is being removed; the card reads request
   metadata off the message.)
3. **Worker hook** — `request_disclosure_approval` builtin: schema, prompt
   availability, dispatch through `authorizeToolExecution`; the **self-disclosure
   short-circuit** (`askerUserId === ownerUserId` → no request, no suspension,
   answer proceeds); the single creation transaction for the asker≠owner case
   (request + card message + alert + `waiting_approval` flip); resume path
   injects the verdict. Rebuild `@nessie/worker` (dev API embeds built `dist`).
   A worker test asserts self-disclosure persists **no** `ApprovalRequest` row
   and that a second, differently-owned ask still raises one.
4. **Chat card** — extract/generalise the `RunStopContinue` pattern into one
   approval card parameterised by the request's `action`. For
   `disclose_information`: the owner-only view with **"See the answer first"**
   (reveals the draft) and **Share it / Keep it private**; the anonymous
   "Waiting for approval to share information" view for everyone else; the
   asker's **withdraw** affordance; the neutral expired/terminal states. Also
   render the existing `approval_required` tool-gate request with its own
   approver rule. Wire into the message feed for every approval-carrying
   channel/thread, and mount the same card standalone off the owner's alert so a
   non-member owner can act without entering the channel.
5. **Remove the `/approvals` page** — delete `admin/src/pages/ApprovalsPage.tsx`,
   its `/approvals` route, the "Approvals" nav item, and its now-unused data
   hooks; keep the resolve route/service and `approval.resolved`. Backfill a
   card message for any already-pending `ApprovalRequest` so no open approval is
   stranded when the page disappears. (Phase 1 already made every raise site
   attach the channel + card, so from here forward every approval has a home.)
6. **Alerts** — confirm `api/src/services/alerts.ts` list/read paths handle
   `approval_requested` (the `visibleUserAlertWhere` scope is generic; verify
   mark-read kinds need no change); push copy via the existing web-push
   pipeline.
7. **Realtime** — verify `message.updated`/`message.new`/`alert.created`
   fan-out covers the new writes; add nothing new unless a gap appears.
8. **Tests** — worker: creation transaction + resume on approve/decline
   (mock-LLM scenario where the model calls the tool); api: owner-only resolve
   entitlement (non-owner refusal), transaction atomicity, alert row +
   `eventKey` idempotency; admin: card renders owner-enabled/other-waiting/
   disabled-after-acting (Playwright, headless, per repo verification rules);
   fixtures include non-English/misspelled asker phrasing to prove the trigger
   is model-judged, never keyword-matched. DB suites follow the shared-database
   rules (seed-scoped cleanup, no global counts, `DATABASE_URL` exported via
   Turbo).
