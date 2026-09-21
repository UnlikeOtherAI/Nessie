# Channel decision settings evaluation

The home for channel decision rules is **Channel settings → Agent decisions**,
opened from the channel header's existing settings action. A channel manager
can enable Jev, edit channel guidance and the confidence threshold, define
acknowledgements, and add questions with named outcomes. Each outcome either
needs no further work or asks an agent already in that channel to carry out
written instructions. Every question retains at least one outcome without
follow-up work.

The dialog preserves unfinished edits across channel refreshes and leaves
the saved policy untouched when only channel metadata is edited. A detected
policy change from another editor asks the person to load the current version
before saving their decisions. This is a local conflict check; the channel
update API does not provide atomic revision matching.

`pnpm --filter @nessie/admin test:e2e:channel-decisions` drives the production
dialog with headless Playwright and substitutes only API persistence. It
proves four named outcomes, agent follow-up instructions, multilingual reaction
guidance, duplicate-outcome refusal, save/reopen, disabling, failed-save retry,
refresh-safe drafts, detected concurrent changes, and the management permission
gate. Screenshots cover the desktop and phone dialog and the phone outcome
editor in `e2e/screenshots/channel-decisions/`.

The runner starts its own admin server and refuses an occupied port. Set
`NESSIE_API_PORT` and `NESSIE_ADMIN_PORT` to a free fixed pair for this
worktree. No API server, database or live model is needed for this component
flow; API authorization and classifier execution are verified by their own
suites. The development HTML must contain `@vite/client`.

For a CI preview build, set `NESSIE_CHANNEL_DECISIONS_E2E_FIXTURE=1` and
`NAV_E2E_ADMIN_MODE=preview`. The flag adds this fixture to Vite's explicit
inputs and to the admin build cache key. Ordinary production builds omit it.
`CHROMIUM_PATH` can select an installed Chromium executable.

The on-request `Browser Suites` workflow enables the fixture, runs the flow,
and retains the `channel-decisions-screenshots` artifact. Runtime suites also
pin enum construction, probabilities, Ledger usage and credit refusals,
snapshot replay, live binding checks, private-source disclosure, and queued
instructions and reply placement.
