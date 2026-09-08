# Member management browser evaluation

`pnpm --filter @nessie/admin test:e2e:member-management` renders the real
Members roster and its facades against a stateful, in-browser UOA boundary. It
never contacts UOA or sends email. The fixture proves desktop and phone flows
for role changes, organisation activation, team removal, invitations, team
access, live permission withdrawal, request refusal and list refreshes.

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
