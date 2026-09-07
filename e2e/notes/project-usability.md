# Project usability browser evaluation

\`pnpm --filter @nessie/admin test:e2e:project-usability\` drives the real
admin at \`http://localhost:5455\` and the real API on \`5454\`. The suite
adopts the servers already running in the local development loop; it does not
start or stop them. It skips when \`DATABASE_URL\`, the API, or the admin is
unavailable.

Authentication uses the existing navigation seed: \`/api/auth/dev-login\` on
a database with an owner, with bootstrap as the fallback for a fresh database.
The seed reuses an entitled project, creates two uniquely named boards through
the public board route, then creates the tickets through the visible New task
dialog. The test verifies persisted board placement through the board read
after the browser drag, which keeps the durable check tied to the same API the
person uses.

The evaluation covers:

- create and edit a ticket, then move it between lifecycle columns;
- board isolation on desktop and through the phone board switcher;
- horizontal board paging through a real CDP touch swipe; and
- the 44px labelled drag handle contract on a phone-sized card.

Set \`PROJECT_USABILITY_SCREENSHOTS=1\` to save desktop and phone checkpoints
under \`e2e/screenshots/project-usability/\`.
