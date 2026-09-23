# Executor attention badges

The Executors sidebar count and each machine's review badge consume the same
`GET /api/executors/attention` query. A machine contributes one change only when
its latest proposed permissions need review and the caller can manage it. Old
pending revisions, revoked machines, unfinished pairing and historical draft
receipts do not contribute. Those decisions belong to the API, not a second
client-side interpretation of executor history.

The row's **1 change to review** link opens that machine's **Permissions** tab
through normal navigation. Ordinary row activation still opens machine detail.
No badge renders for zero work or a failed/unauthorized summary, including when
a previous successful result remains cached. The shared query refreshes every
30 seconds while visible, on window focus, and after executor mutations through
the existing executor cache family.

Run `node admin/e2e/executor-attention/run.mjs` from the repository root. The
headless evaluation starts this checkout's live Vite server by default, or its
built preview when `NAV_E2E_ADMIN_MODE=preview`, on its configured ports and
refuses to adopt an existing server. It renders the actual sidebar and
executor table at desktop and phone widths, tests keyboard/touch review
navigation, checks the shared fetch, clears resolved counts and verifies that
a denied refresh removes cached badges. Screenshots are written under
`e2e/screenshots/executor-attention/`.

The fixture supplies API responses and does not claim server authorization
coverage. The executor-management API tests own latest-revision selection and
caller entitlement.

The Browser Suites workflow enables seven isolated executor preview entries in
its Navigation Transitions job, run together in its executor step:

| Fixture | Build flag |
| --- | --- |
| Pairing | `NESSIE_EXECUTOR_PAIRING_E2E_FIXTURE=1` |
| Agent access | `NESSIE_EXECUTOR_AGENTS_E2E_FIXTURE=1` |
| Machine detail | `NESSIE_EXECUTOR_DETAIL_E2E_FIXTURE=1` |
| Attention badges | `NESSIE_EXECUTOR_ATTENTION_E2E_FIXTURE=1` |
| Run launcher | `NESSIE_EXECUTOR_RUN_LAUNCHER_E2E_FIXTURE=1` |
| Conversation leases | `NESSIE_EXECUTOR_LEASE_E2E_FIXTURE=1` |
| Tool screenshots | `NESSIE_TOOL_SCREENSHOTS_E2E_FIXTURE=1` |

`pnpm --filter @nessie/admin test:e2e:executor-lease` renders the real
composer, with the lease chip the launcher hook hands it, a reply panel's
composer with the chip scoped to its root (`?view=reply&root=`), and the machine
detail page's Activity tab, over runner-supplied API answers. It pins that the
holder sees "Minis · local apps · until HH:MM · End" beside Run on executor
only once the composer opens (its at-rest height is the member's), that
another member asking about the same thread sees nothing, that End posts for
that lease and the chip goes, that a phone folds the chip into a dot and the
launcher dialog carries the lease and its End, that a room's launch — which
carries only in its own reply thread — puts no chip and no dot on the room's
composer but a chip with a whole End in that reply panel's composer at desktop
and phone width, and none in another reply thread's, and that the machine's
*Local apps in use* list names agent, conversation, person and last use — or
says it may not — with End on screen at phone width. Screenshots go to
`e2e/screenshots/executor-lease/`. Who gets which answer is the API's job and
is covered by `api/test/executor-lease-routes.test.ts`.

`pnpm --filter @nessie/admin test:e2e:tool-screenshots` renders the real
thought-process dialog on a live run and the real agent page Activity tab, with
the screenshot Kelpie really returned on Windows. It pins that a tool line shows
no thumbnail while its call runs and both once the next thought shows the call
returned (the dialog reads the full thought log again, once), that each
thumbnail comes from the thumbnail route when its ref has one and from the
original otherwise, that a press opens the original in the attachment viewer —
over the dialog in the blocking layer, where Escape closes only the viewer and
gives focus back to the thumbnail — and that the tool execution log shows the
same thumbnails on the call's card and none on the others, at 1280 px and at
390 px under a finger with no sideways scroll. Screenshots go to
`e2e/screenshots/tool-screenshots/` and join the executor upload. Which refs a
viewer is given is `api/test/tool-call-screenshots.test.ts`'s job.

Each flag adds its `admin/e2e/executor-<name>/index.html` as a Vite build input
and participates in Turbo's admin-build cache key. Ordinary release builds
leave these flags unset and omit the fixture entries. To verify the CI path
locally, build with the relevant flags and run the suites with
`NAV_E2E_ADMIN_MODE=preview`; the runners require `@vite/client` only in dev
mode. Dispatch Browser Suites for a branch with
`gh workflow run browser-suites.yml --ref <branch>`.
