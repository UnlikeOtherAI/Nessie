# Project usability browser evaluation

`pnpm --filter @nessie/admin test:e2e:project-usability` drives the real admin
at `http://localhost:5455` and the real API on `5454`. The suite adopts the
servers already running in the local development loop; it does not start or
stop them. It skips when `DATABASE_URL`, the API, or the admin is unavailable.

`pnpm --filter @nessie/admin test:e2e:connected-board-sources` drives the same
admin with HTTP fixtures named **UnlikeOtherAI QA**. It checks source settings,
mapping failure rollback, board-scoped health/sync doorways, and a wrapping
phone strip without a provider credential. CI runs it after the project-
usability lifecycle in the same fixed server session; provider sync and webhook
delivery stay covered at the API and worker boundary.

Authentication uses the existing navigation seed: `/api/auth/dev-login` on a
database with an owner, with bootstrap as the fallback for a fresh database.
The seed reuses an entitled project, creates board A through the project's
Configure → New board doorway, creates board B through the public board route,
then creates the tickets through the visible New task dialog. A board owns its
columns and the tickets put on it; switching boards must therefore show the
destination board's own first-column ticket while leaving board A's tickets
out. The test verifies persisted placement through the board read after the
Column control is saved, which keeps the durable check tied to the same API the
person uses.

The board's Column choice is a draft until Save changes, and the card's
labelled drag handle is the touch affordance while the card body remains a
scrollable surface. Task labels and custom fields remain project-scoped across
boards pending the product approval that changes that contract; this
evaluation does not infer board-local field definitions.

The evaluation covers:

- create and edit a ticket, then move it between lifecycle columns;
- board isolation on desktop and through the phone board switcher;
- vertical scrolling through a populated column;
- horizontal board paging through a real CDP touch swipe; and
- the 44px labelled drag handle contract on a phone-sized card.

The run archives its uniquely titled tickets and deletes its two uniquely
named boards in `finally`. Set `PROJECT_USABILITY_SCREENSHOTS=1` to save
desktop and phone checkpoints under `e2e/screenshots/project-usability/`.
