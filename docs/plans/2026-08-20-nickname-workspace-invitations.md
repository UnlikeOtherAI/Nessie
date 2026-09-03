# Nickname-addressed workspace invitations

**Status:** Proposed
**Scope:** UnlikeOtherAuthenticator (UOA) and Nessie
**Reviewed:** Kimix CLI, 2026-08-20

## Outcome

An organisation owner or admin can invite an existing UOA person from Nessie's
**Settings → Members** screen using either their email address or their UOA
nickname. UOA resolves a nickname privately, sends the email invitation, owns
the invitation and its acceptance, and remains the only authority for the
person's profile and identity. Nessie never resolves a nickname to an email and
never stores either a nickname or an invitation record.

The Members page is both the feature's home and its doorway: an owner or admin
is already there to decide who should join. Local/no-IdP installations retain
their existing local-member workflow; nickname invitations are UOA-only.

## Decisions

### Nickname is UOA-owned identity data

UOA adds an optional nickname to a user profile. It is not copied into Nessie,
session metadata, or an audit payload. The field is global to UOA, not scoped to
an organisation or a relying product, so a person has one unambiguous nickname
wherever they are invited.

The canonical stored form is ASCII lowercase and must match
`[a-z0-9][a-z0-9_-]{2,31}`. UOA trims input, lowercases it before validation,
and enforces a unique `CITEXT` value (or an equivalent case-insensitive unique
index) in the database. Restricting the first version to ASCII avoids different
Unicode normalisation/case-folding rules between browser, API, and database.
`@` is prohibited, so nickname and email address syntax stay distinct.

Users set or replace a nickname in their UOA account profile; the account menu
is the doorway to that setting. Replaced nicknames become UOA-held tombstones:
they cannot resolve and cannot be claimed by another subject. This prevents a
future nickname claim from changing the apparent target of an old conversation
or invitation. A future product decision can add an explicit recovery policy,
but it must retain that no-reassignment guarantee.

### Nickname invitation is a UOA operation, not a lookup

UOA extends its existing team-invitation endpoint. Each invite uses exactly one
target:

```ts
type InviteTarget =
  | { email: string; name?: string; teamRole?: string }
  | { nickname: string; teamRole?: string }
```

There is no `GET user by nickname` route and no response field that reveals a
nickname's email address. For nickname input, UOA resolves the current user
inside the authorised invitation service, uses that person's verified delivery
email internally, and creates an invitation bound to the stable resolved UOA
subject. A later nickname change, nickname tombstone, or email change cannot
redirect an invitation. Resends use the bound subject's current verified email,
never re-resolve the nickname.

The UOA `TeamInvite` model therefore gains the durable target facts needed for
the nickname branch:

- `recipientKind` (`email` or `nickname`),
- nullable `recipientUserId` referencing the resolved UOA user for nickname
  invitations, and
- an optional nickname snapshot for the UOA invitation history.

The existing email field remains UOA-internal delivery data. The API serializes
an email only for an email-targeted invitation; nickname-targeted results and
history expose the submitted nickname (or no target), never the resolved email.
Acceptance checks `recipientUserId` where present, while existing email-target
invitations retain their current behaviour.

### Privacy and audit policy

A syntactically valid nickname request always gets the same public nickname
result (`requested`) whether it creates an invitation, the person is already a
member, the nickname is absent, or that user cannot receive an invite. UOA logs
the actual internal reason but sends no target-specific error or status to
Nessie. Syntax errors are rejected before resolution. This prevents the invite
action from becoming a nickname existence or workspace-membership oracle; it
does not weaken the existing owner/admin gate or UOA's invitation rate limit.

UOA's backend-mode audit has no acting user, so Nessie records every successful
invitation submission — email and nickname alike — in its tamper-evident audit
chain. The entry contains the authenticated actor, organisation/team, request
id, target *kind*, and UOA outcome/invitation reference where available. It
does not contain an email, nickname, display name, or a second invitation
record. This is product-specific action evidence, not a competing identity or
invitation authority.

## Delivery plan

1. **Define the UOA nickname profile contract.**
   - Add an additive UOA Prisma migration for the optional nickname and its
     case-insensitive uniqueness constraint, plus a reservation/tombstone model
     for replaced names. Do not backfill from email or display name.
   - Add server-side nickname validation, profile read/write service methods,
     and an authenticated UOA account-profile control to set or replace it.
   - Ensure profile/claim serializers expose a nickname only where a profile
     is already authorised to be shown. Nessie does not need that field for the
     invitation flow.
   - Update UOA's profile, identity, and API documentation. The existing
     statement that email is the username must distinguish sign-in email from
     the optional invite nickname.

2. **Extend the UOA invitation service without breaking email invitations.**
   - Change the bulk and member invite body schemas to a strict, discriminated
     email-or-nickname union. Reject both fields and neither field before any
     lookup; retain the email branch's existing `name` semantics only there.
   - Resolve a nickname under the same tenant transaction that creates the
     invitation. Persist the resolved user id and nickname snapshot, deliver to
     the canonical UOA email, and bind acceptance/resend to that subject.
   - Preserve the legacy email request and response shape. For nickname
     targets, return only the nickname and the uniform `requested` status;
     update invitation-list serialization so it cannot leak the resolved email.
   - Keep current route authorisation, backend-mode feature gates, SSRF/egress
     posture, rate limits, and hosted UOA acceptance unchanged. Update the
     machine-readable `/api` contract and `/llm` instructions together with the
     route implementation.

3. **Add Nessie's transparent, audited relay.**
   - In `packages/schemas/src/uoa-roster.ts`, replace the email-only invite type
     with the same exactly-one target union; add optional nickname fields to
     invite result and history records.
   - Update `api/src/routes/workspace-members.ts` so the Zod body schema
     enforces exactly one target after the existing owner/admin gate. The route
     continues to resolve the linked UOA workspace from the actor's mapped
     organisation/team and never looks up local users.
   - Update `packages/workspace-admin/src/uoa-org-roster.ts` to forward the
     selected target unchanged, parse nickname-only UOA rows, and never invent
     or hydrate an email. Keep `safeFetch`, DNS pinning, and the established
     error mapping intact.
   - Write one Nessie audit-chain entry only after UOA accepts the submission.
     Use the existing audit writer and actor context; metadata is limited to
     non-profile facts described above. A failed upstream request writes no
     success event.

4. **Make nickname invitations reachable in the Members screen.**
   - Replace the email-only `type="email"` field in
     `admin/src/pages/settings/TeamMembersSection.tsx` (renamed from
     `WorkspaceMembersSection.tsx` by the 2026-09-03 workspace→team rename,
     commit `4fe11c54`) with an explicit target-kind control and a matching
     input. Do not infer intent from `@` or any other text heuristic.
   - Email preserves email validation and current copy. Nickname uses the UOA
     nickname rules, explains that UOA sends the email privately, and shows a
     neutral confirmation for a submitted nickname request.
   - Render nickname-targeted pending rows from their nickname snapshot; never
     fall back to an email field that UOA deliberately omitted. Continue to
     refresh the live UOA invitation list after a mutation.

5. **Document, verify, and release in dependency order.**
   - Update Nessie's SSO identity invariant in `docs/brief.md`, the UOA roster
     and invitation contract in
     `docs/deployment-modes-and-auth-spec/authentication.md`, and Phase 5 / row
     3b in `docs/plans/2026-08-14-uoa-sso-gap-analysis.md`.
   - Update UOA's brief, profile documentation, invitation endpoint schema,
     `/llm` contract, and deployment guide. Both repositories must describe
     that UOA owns nickname resolution and email delivery.
   - Release UOA's migration, profile setting, and invitation-union API first.
     Deploy and smoke-test that version before releasing Nessie's relay, then
     the Members UI. Nessie must never render a nickname control against an
     UOA deployment that does not support the union contract.

## Verification matrix

### UOA

- Migration tests prove case-insensitive uniqueness, nullable no-backfill
  behaviour, and the nickname tombstone cannot be claimed by another user.
- Profile tests cover valid creation, invalid characters/length, replacement,
  and the account-menu/profile doorway.
- Invitation service and route tests cover email compatibility; exactly-one
  target validation; nickname resolution; no generic lookup; uniform nickname
  result for unknown, already-member, and successful cases; outbound email;
  resend after nickname/email change; and acceptance only by the bound subject.
- Serialization tests prove nickname invitation results and list rows never
  expose the resolved email. The UOA endpoint schema and `/llm` output match
  the executable contract.

### Nessie

- Extend `packages/workspace-admin` tests to assert that a nickname payload is
  relayed without an email and nickname-only UOA responses parse correctly.
- Extend `api/test/uoa-workspace-members.test.ts` for both/neither target
  rejection, owner/admin gating before UOA calls, no-local-lookup behaviour,
  nickname response privacy, and successful audit-chain entry creation.
- Extend the Members-page invitation tests with the nickname target control,
  validation, neutral confirmation, and a nickname-only pending row. Retain the
  email branch assertions.
- Run the affected package tests through Turbo with `DATABASE_URL` where
  applicable, then Nessie's lint-gated root build/typecheck. Run UOA's required
  migration, lint, build, and test checks under its documented workflow.
- Start Nessie with the normal polling dev process, verify the API health
  endpoint, and use headless Playwright on `http://localhost:5455` to submit a
  nickname invitation from Settings → Members and inspect the screenshot.

### Production smoke test

Use two controlled UOA accounts: the target sets a nickname, a workspace owner
submits it from Nessie, the target receives and accepts the hosted UOA email,
and Nessie's live roster then shows the new member. Verify that the owner never
sees the target's email on the nickname request or pending-invitation row, and
that a renamed nickname cannot change the recipient of an already-created
invitation.
