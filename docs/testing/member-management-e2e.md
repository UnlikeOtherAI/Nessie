# Member management browser evaluation

`pnpm --filter @nessie/admin test:e2e:member-management` renders the real
Members roster and its facades against a stateful, in-browser UOA boundary. It
never contacts UOA or sends email. The fixture proves desktop and phone flows
for role changes, organisation activation, team removal, invitations (including
a same-email, same-team resubmission sent through to UOA), explicit resend and
cancellation, team access, live permission withdrawal, request refusal and
list refreshes. UOA remains the authority for the atomic
one-actionable-invitation rule; the fixture retains one pending row after that
second submission.

The pending-approval case deliberately exposes no resend, cancellation, or
approval decision. An invitation awaiting UOA approval has not been sent, and
approval belongs to UOA's organisation approval workflow rather than Nessie's
member roster.

The Navigation Transitions CI job runs this fixture through the existing
managed API/admin lifecycle and retains screenshots in
`e2e/screenshots/member-management/`. Its build alone sets
`NESSIE_MEMBER_MANAGEMENT_E2E_FIXTURE=1`, making the fixture a Vite preview
entry. Ordinary production builds omit that entry; Turbo includes the flag in
the admin-build cache key so those two artifacts cannot be reused for each
other.

The same Navigation Transitions build sets
`NESSIE_APP_CONNECT_SCOPE_E2E_FIXTURE=1` for its isolated App connection
scope fixture. It follows the same preview-only and cache-key rules.
