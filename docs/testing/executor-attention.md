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
headless evaluation starts this checkout's live Vite server on its configured
ports and refuses to adopt an existing one. It renders the actual sidebar and
executor table at desktop and phone widths, tests keyboard/touch review
navigation, checks the shared fetch, clears resolved counts and verifies that
a denied refresh removes cached badges. Screenshots are written under
`e2e/screenshots/executor-attention/`.

The fixture supplies API responses and does not claim server authorization
coverage. The executor-management API tests own latest-revision selection and
caller entitlement. The fixture is a development entry and is not a production
bundle input.
