# As built

Part of [the project boards design](overview.md).

## 12. As built

Every phase in §9 shipped. This section records where the code differs from the
design above, so the design stays readable as intent and this stays true as
fact. Read this before treating any section above as a description of the code.

### Deltas

- **§3.7 the board filter** is stored, contract-checked and applied
  (`boardFilterWhere`), but **has no editor**. A board's filter can only be set
  through the API today. Deliberate: a control that narrows a board is only
  legible once a project has more than one source or a select field to narrow
  by, and shipping an empty picker would have been a control that names no
  decision.
- **§5.7 write-back for `updateProjectTask`** covers title, detail and deadline.
  Priority and custom fields are **not** written upstream — they are mapped
  *inbound* only. A person editing a mapped custom field on a mirrored task
  changes Nessie's copy, and the next sync overwrites it. This is the one place
  where local and remote can disagree, and it is the first thing to close.
- **§5.10 `misconfigured` for `FIELD_GONE`** is not detected: a mapped external
  field that disappears upstream simply stops being written. `UNMAPPED_STATE`,
  `CONTAINER_GONE`, `WEBHOOK_REGISTRATION_FAILED` and
  `PROVIDER_NOT_CONFIGURED` all are.
- **§6.1 two doorways** are not built: the column header's *Edit columns* menu
  (the settings page is reachable from the header's Configure menu instead), and
  the Overview Work section's per-source health line (the board's own
  `SourceStatusStrip` carries it).
- **§7.5 `ticket_list`** did not gain its optional `boardId`. It still lists a
  project's tasks; `ticket_board_read` lists every board with its columns, which
  is what `ticket_move` needs.
- **§9 phase 6, GitHub Projects v2** is read-only. `applyChange` refuses a
  write-back to a Projects board by name
  (`GITHUB_PROJECT_READ_ONLY`) rather than pretending to have made one;
  repository issues write back fully.
- **§5.6 `board-source.sync.sweep`** is not a queue topic. The worker's own
  30-second interval claims due sources directly, exactly as the dashboard
  refresher does, so there is no second scheduler.

### Not yet verified against a live vendor

Every adapter is unit-tested on its normalisation, its state mapping and its
signature verification, and the whole inbound and write-back path is tested
against a real database with a stand-in adapter. **None of the four has been
run against the real provider**, because that needs an app registered with each
vendor — see
[configuration](../../deployment/configuration.md) → "Project board sources".
The specific assumptions to check on first connect:

- **Linear** — that app-level webhooks fire for every authorised workspace, and
  that `Linear-Signature` is an HMAC-SHA256 of the raw body. A wrong assumption
  here costs freshness only: the adapter declares a five-minute poll.
- **Jira** — that `/rest/api/3/search/jql` paginates by `nextPageToken` as
  documented, and that the developer console permits this deployment's callback
  domain for webhook registration.
- **GitHub** — that a classic OAuth token reaches `projectsV2` on the viewer
  (a GitHub App installation token does not).
- **Trello** — that the token arrives in the fragment as `token=` and that
  `x-trello-webhook` is base64(HMAC-SHA1(body + callbackURL)).
