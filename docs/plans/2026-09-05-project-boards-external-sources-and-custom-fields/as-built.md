# As built

Part of [the project boards design](overview.md).

## 12. As built

Every phase in §9 shipped. This section records where the code differs from the
design above, so the design stays readable as intent and this stays true as
fact. Read this before treating any section above as a description of the code.

### Deltas

- **§5.8 email auto-matching shipped later than the rest of §5.8.** The column,
  the `matchedBy: 'email'` vocabulary and the People table all shipped with the
  first release; nothing wrote a match, so every provider user had to be mapped
  by hand. It now runs in `packages/team-admin/src/board-source-identity.ts`
  from three places: attaching a container matches the members the adapter
  describes, and each sync page and webhook delivery matches the assignees the
  items themselves name — which is what covers somebody who joined the upstream
  team after the source was attached, without a second provider call. An
  external user that already has a link row is never re-matched, so a person's
  choice — including a deliberate *Not linked* — survives every sync.
- **A mapping reaches the items already mirrored.** §5.8 did not say what
  happens to the cards that were synced before a link existed, and the answer
  was "nothing until somebody upstream touches them", because an unchanged item
  fingerprints identically and is skipped. `reprojectIdentityLinks` re-applies
  a changed link to every `TaskExternalLink` in the tenant that names that
  provider user: the assignee, the `todo`-category `inbox`/`assigned` split,
  and `remoteAssigneeDisplay`.
- **§6.4 the unmapped-assignee pill is not "muted".** A muted chip is what a
  *known* colleague and *Unassigned* both render as, so a third identical chip
  claimed an account that does not exist. It ships as
  `admin/src/components/kanban/RemotePersonPill.tsx`: the outlined chip the
  item's own key pill uses, a crossed-out person glyph, and a title naming the
  remedy. The `TaskDialog` says the same thing in words beside the assignee
  picker, and the People table shows each member's address with a *Matched by
  email* chip on the rows an address resolved.
- **Two defects the above closed.** A link row that named nobody used to count
  as a resolved identity, which cleared `remoteAssigneeDisplay` and left the
  card reading *Unassigned* rather than naming the provider user; and saving the
  People table rewrote every submitted row as `matchedBy: 'manual'`, which both
  erased the provenance the table shows and created an empty row for every
  stranger — the row that then blocks a later email match. The save now writes
  only the rows whose identity actually changed.
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

### Superseded

- **§5.1 "Auth (deployment ↔ person)" is no longer OAuth-only for Linear.**
  `BoardSourceAdapter.oauth` is now `auth: { oauth?, apiKey? }`, and Linear
  declares both: a personal API key that needs nothing registered on the
  deployment, and the OAuth grant where an app exists. Linear therefore
  registers unconditionally, and `GET /api/board-sources/providers` answers
  which ways in each provider offers here rather than a bare list of names.
  `BoardSourceConnection.authMethod` records which one made a connection, so
  the remedy offered is the one that can actually work. Jira, GitHub and Trello
  are unchanged and still OAuth-only; the design for their key paths is
  [2026-09-05-api-key-board-source-connectors](../2026-09-05-api-key-board-source-connectors/overview.md).

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
- **Linear, API key** — that `Authorization: <key>` without a `Bearer` prefix is
  accepted (the shared `linearGraphQl` helper has always sent the token bare,
  so the OAuth path has the same assumption), and that `VIEWER_QUERY` returns
  `organization { id }` under a personal key as it does under a grant. Both are
  what `verify()` depends on to identify the workspace. A personal key's own
  scopes are **not** readable, so a key created without Write connects, syncs,
  and refuses the first drag with `LINEAR_UPDATE_REFUSED`.
- **Jira** — that `/rest/api/3/search/jql` paginates by `nextPageToken` as
  documented, and that the developer console permits this deployment's callback
  domain for webhook registration.
- **GitHub** — that a classic OAuth token reaches `projectsV2` on the viewer
  (a GitHub App installation token does not).
- **Trello** — that the token arrives in the fragment as `token=` and that
  `x-trello-webhook` is base64(HMAC-SHA1(body + callbackURL)).
