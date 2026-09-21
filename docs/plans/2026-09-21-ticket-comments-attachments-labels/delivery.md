# Delivery

Part of [ticket comments, attachments and labels](overview.md).

## 6. Delivery

Three waves of at most three Opus implementers each, after a contract wave
the orchestrator does alone. Every agent owns an **exclusive** file list and
never edits outside it; anything an agent finds it needs outside its list is
reported to the orchestrator, not edited. Each wave's gate runs from the
integration branch after merge, with `DATABASE_URL` exported and `--no-daemon`
(agents run concurrently; the Turbo daemon crosses worktrees).

Standing rules for every agent: worktree of its own; commit and push every
turn; no `git add -A`; Prisma fakes are extended in the same commit as the
query they model; a new test lives where its package's `test` script globs;
a DB-backed test proves it fails without the fix at least once during
development (say so in the commit); no vendored code, no dependency patches.

### 6.1 Wave 0 — the built contract (orchestrator, before anything parallel)

Files:

```
api/prisma/schema.prisma                                   §1.2
api/prisma/migrations/20260921120000_task_labels_comments_attachments/migration.sql   §1.3
packages/schemas/src/task-labels.ts · task-comments.ts · task-attachments.ts · index.ts
packages/schemas/src/task-records.ts        (labels, commentCount, attachmentCount, viewerCanEdit)
packages/schemas/src/board-sources.ts       ('native:labels')
packages/schemas/src/realtime-ws.ts         ('task.activity', TaskActivityEventSchema)
packages/board-sources/src/items.ts · adapter.ts   (types only, §4.1; http.ts stays for C)
packages/team-admin/src/project-task-records.ts    (fill the four new record fields — minimal include + _count)
api/src/contracts/tasks-board.ts            (labelIds, attachmentIds on the bodies)
```

Gate (all green before wave 1 starts):

```
pnpm exec turbo run build --no-daemon --filter=@nessie/schemas --filter=@nessie/board-sources --filter=@nessie/team-admin
pnpm --filter @nessie/api exec prisma generate
pnpm exec turbo run typecheck --no-daemon            # every consumer of TaskRecord compiles; cast fakes in tests updated here
DATABASE_URL=… pnpm exec turbo run test --no-daemon --filter=@nessie/api --filter=@nessie/team-admin --filter=@nessie/worker
# migration on a throwaway pgvector container from empty, and on the upgrade baseline (scripts/generate-upgrade-fixture.mjs flow)
```

### 6.2 Wave 1

**Agent A — services, routes, access, realtime (server).**

```
packages/team-admin/src/task-labels.ts · task-comments.ts · task-attachments.ts · task-access.ts · task-activity-realtime.ts
packages/team-admin/src/project-tasks.ts          (labelIds in create/update; detail_edited event; attachmentIds link)
packages/team-admin/src/index.ts
packages/team-admin/test/task-labels.test.ts · task-comments.test.ts · task-attachments.test.ts   (DB-backed)
api/src/services/task-labels.ts · task-comments.ts · task-attachments.ts · attachments.ts (taskId arm)
api/src/routes/task-labels.ts · task-comments.ts · task-attachments.ts · tasks.ts (labelIds, attachmentIds, publish task.updated)
api/src/routes/uploads.ts                          (DELETE refuses taskId-linked)
api/src/register-api-routes.ts
api/test/task-labels-routes.test.ts · task-comments-routes.test.ts · task-attachments-routes.test.ts · attachment-unlinked-access.test.ts
```

Tests A must add: label CRUD and `LABEL_NAME_TAKEN` by normalised name;
`setTaskLabels` partitioning on a mirrored task with a stand-in `writeBack`
(read_only refusal, read_write echo, `LABEL_NOT_IN_PROJECT_SOURCE`);
comment author-only edit/delete for a person and for an agent author;
comment delete removes its attachments through the file service; link doors
skip ids the actor did not upload; the `taskId` ACL arm admits a project
member and refuses an outsider; `task.activity` and `task.updated`
publications; `TaskEvent` rows per §2.6.

**Agent B — admin primitives, editor, facades (client foundation).**

```
admin/package.json · pnpm-lock.yaml                (tiptap pin to one 3.31.x; +@tiptap/markdown, +@tiptap/extension-image)
admin/src/components/primitives/TokenInput.tsx · token-input-keys.ts · LabelPill.tsx
admin/src/components/shared/LabelColorPicker.tsx
admin/src/components/shared/markdown-editor/MarkdownEditor.tsx · RichTextToolbar.tsx · AttachmentImageNode.tsx · markdown-editor-upload.ts
admin/src/components/features/knowledge/RichTextEditor.tsx   (adopts RichTextToolbar; behaviour unchanged)
admin/src/components/features/channels/MessageMarkdown.tsx · AuthedAttachmentImage.tsx   (resolveAttachmentImages)
admin/src/facades/tasks/keys.ts · task-labels/hooks.ts · task-comments/hooks.ts · task-attachments/hooks.ts
admin/src/facades/projects/keys.ts                 (labels)
admin/src/facades/agents/realtime.ts               (task.activity handler)
admin/src/styles.css                               (.admin-label-pill, .admin-token-input, .task-dialog-form geometry)
admin/test/token-input-keys.test.ts · label-pill.test.ts · markdown-editor-roundtrip.test.ts · message-markdown-attachment-images.test.ts · query-key-invariants.test.ts (updated)
```

Tests B must add: the pure key-handling table (§5.7 keys, every row);
`LabelPill` renders the inline `--label` and no raw hex in a class; Markdown
round-trip idempotence over a fixture set (headings 2–3, nested lists,
links, inline code, fenced code, images with the attachment path, plain
text) — `serialise(parse(md))` is a fixed point after one pass;
`MessageMarkdown` swaps only `INLINE_ATTACHMENT_PATH` images for the authed
component. B also re-runs the knowledge editor's existing unit tests and
`pnpm --filter @nessie/admin test:e2e:knowledge-markdown` after the pin.

**Agent C — board sources: contract implementation, Linear, apply, worker.**

```
packages/board-sources/src/http.ts                 (sourceFetchStream, SourceAssetTooLargeError) · errors.ts · index.ts
packages/board-sources/test/http-stream.test.ts
packages/board-source-linear/src/queries.ts · normalise.ts · adapter.ts · index.ts
packages/board-source-linear/test/*                (normalise labels/colour/attachments/inline; comment lane paging; webhook parse for Comment/IssueLabel; applyChange labelIds; comment mutations)
packages/team-admin/src/board-source-apply.ts      (native:labels arm, rewriteProviderUrls in the detail write)
packages/team-admin/src/board-source-apply-activity.ts   (comments, assets, fetchPendingAssets)
packages/team-admin/src/board-source-identity.ts   (match comment authors; reprojectIdentityLinks re-attributes comments)
packages/team-admin/src/board-source-writeback.ts  (createComment/updateComment/deleteComment collaborator; labelIds)
packages/team-admin/test/board-source-apply-activity.test.ts   (DB-backed, stand-in adapter)
api/src/routes/board-sources/sources.ts            (attach seeds native:labels; no Labels definition)
worker/src/control/board-source-sync.ts · board-source-webhook.ts   (comments on pages; resource:'label' → describe; removed comment ids; one task.activity per job)
worker/test/board-source-sync-activity.test.ts
```

Tests C must add: fingerprint unchanged by comments; labels upsert adopts a
same-name Nessie label; source-owned link subset replaced, Nessie-only links
kept; comment upsert insert/update/soft-delete and the `restricted` skip;
asset pending → stored with the URL rewritten in `detail` and in a comment
body; three failures → `failed`, text untouched; a 26 MiB stream is refused
before the store; webhook `IssueLabel` re-describes and recolours.

Wave 1 gate: the wave 0 commands plus
`DATABASE_URL=… pnpm exec turbo run test --no-daemon` (whole repo), root
`pnpm lint` (test-glob and migration lints included),
`pnpm --filter @nessie/admin test`, and the knowledge-markdown browser suite.

### 6.3 Wave 2 (starts from the integration branch with wave 1 landed)

**Agent D — the dialog, the card, label settings, browser coverage.**

```
admin/src/components/features/projects/kanban/TaskDialog.tsx · TaskDescriptionField.tsx · TaskDocuments.tsx · TaskAttachmentsSection.tsx · TaskCommentsSection.tsx · TaskCommentRow.tsx · TaskCommentComposer.tsx · TaskLabelsField.tsx · TaskFieldControl.tsx (multi_select → TokenInput) · KanbanCard.tsx · TaskFieldChips.tsx
admin/src/pages/project/settings/LabelsSettingsSection.tsx · admin/src/pages/project/ProjectSettingsPage.tsx
admin/src/components/shared/Dialog.tsx             (only if §5.13 needs the xl width change)
admin/e2e/task-dialog/index.html · fixture.tsx · run.mjs   (pure fixture over a stubbed ApiClient)
admin/e2e/project-usability/run.mjs · ci.mjs · admin/e2e/ticket-search/run.mjs   ('Description' textbox; new real-stack steps; suite registration)
admin/vite.config.ts · .github/workflows/browser-suites.yml · turbo.json   (NESSIE_TASK_DIALOG_E2E_FIXTURE — all three edits)
admin/package.json                                 (the test:e2e:task-dialog script line only — B's dependency change has landed)
admin/test/task-dialog-layout.test.ts · draft-surfaces.test.ts · dialog-adopters.test.ts · mutation-feedback.test.ts (allowlist rows as needed)
```

**Agent E — agent tools.**

```
api/src/mcp/tools/boards.ts · task-activity.ts · labels.ts · api/src/mcp/server.ts · api/src/mcp/tool-context.ts (fileService if absent)
api/test/mcp-task-activity.test.ts · mcp-labels.test.ts
packages/runtime/src/builtin-ticket-tools.ts
worker/src/run/pa-tools/tickets.ts (ticket_read lines, ticket_update labelIds) · ticket-comments.ts · ticket-labels.ts · ticket-attachments.ts · worker/src/run/tools.ts (dispatch) · worker/src/run/execute/run-setup.ts (PEER_PROJECT_TOOL_IDS)
worker/test/pa-tools-ticket-activity.test.ts
packages/runtime/test/builtin-tool-categories.test.ts (if the quarter rule needs a count update)
```

Tests E must add: every new MCP tool refuses without its scope; `nessie_task_attachment_add`
stores linked and refuses 10 MiB+; `nessie_task_comment_add` on a read_only
mirror says `propagated: false`; the peer subset admits `ticket_comment_add`
in a project channel and refuses it elsewhere; a shared agent's comment is
authored by the agent with `by` the requester; `ticket_comment_list` stamps
`project:`.

**Agent F — the other adapters and the mapping panel.**

```
packages/board-source-github/src/* · test/*       (label colour, comments lane, inline assets)
packages/board-source-trello/src/* · test/*       (colour table, commentCard lane, attachments)
packages/board-source-jira/src/* · test/*         (comments from fields, restricted, attachments)
admin/src/pages/project/settings/SourceMappingPanel.tsx   (target option "Labels (native)")
admin/src/facades/board-sources/*                  (only if the target vocabulary is typed there)
docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/as-built.md   (§4.3 supersedes §5.3; Linear resource types)
```

Wave 2 gate: wave 1's gate, plus `pnpm --filter @nessie/admin test:e2e:task-dialog`
(dev server and `NAV_E2E_ADMIN_MODE=preview` against a build made with the
flag — confirm the flag changes `admin/dist`), and
`DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:project-usability` on
this worktree's ports.

### 6.4 Wave 3 — integration and verification (orchestrator)

1. Integrate D, E, F; resolve conflicts; re-run the whole wave 2 gate.
2. Documentation (§6.6). Standards routing changes land here, not in an
   agent's wave.
3. `gh workflow run browser-suites.yml --ref <branch>` — the suites are on
   request only; nothing else catches a dialog regression before `main`.
4. **Real-stack browser run** against this worktree's admin port, headless
   Playwright, seeded through the API (the E2E recipe: throwaway pgvector DB,
   bootstrap owner), capturing the screenshots in §6.5.
5. **Linear live check** (needs Ondrej's API key on a disposable team, the
   as-built precedent): one issue with two labels of distinct colours, one
   comment by a mapped person, one by a bot, one inline screenshot in the
   description, one file attachment and one URL attachment. Assert: labels
   with colours; the comments with the right author kinds; the inline image
   resolves through `/api/attachments/…`; the file in Attachments; the URL as
   a link row; a comment posted in Nessie on a `read_write` source appears in
   Linear and comes back with `external` set; a label set from Nessie
   appears in Linear; webhook `Comment` and `IssueLabel` deliveries apply. If
   `uploads.linear.app` refuses the header, record it in as-built as the
   §4.2 note says.
6. One PR from the integrated branch; merge on green; clean up worktrees and
   branches.

### 6.5 Browser checks and screenshots

`admin/e2e/task-dialog/` (pure fixture, no database; registered in
`project-usability/ci.mjs` after `visibility-affordances`) drives the real
`TaskDialog` over a stubbed `ApiClient` and asserts, with screenshots under
`e2e/screenshots/task-dialog/`:

| Screenshot | What it pins |
|---|---|
| `01-details-desktop.png` | two columns; left: Title, Excerpt, Description read view with a rendered image, Documents, Attachments (3 rows incl. one *in description*, one external link, one failed), Comments (person, agent, external author, one *Nessie only*); right: …, Labels with four pills |
| `02-description-editing.png` | editor open with toolbar, Done button, an uploading placeholder |
| `03-labels-open.png` | token popover on focus: chosen first with checks, all labels listed, footer *Manage labels…* |
| `04-labels-filtered-create.png` | typing `perf` → one match and the *Create label "perf"* row |
| `05-labels-keyboard.png` | after ArrowDown ×2, Enter, Backspace ×2: the expected pill set (asserted, then shot) |
| `06-mirrored-readonly.png` | Linear notice, locked source-owned pills, *Comments stay in Nessie* |
| `07-viewer-readonly.png` | `viewerCanEdit: false`: no pencil, no composer, no Upload |
| `08-phone-details.png` · `09-phone-labels-open.png` | 375×812: stacked order, popover below the field, 44 px targets |
| `10-labels-settings.png` | the Labels section with rename in progress and the colour popover open |
| `11-card.png` | a card with three label pills, `+1`, comment and paperclip counts |

`project-usability/run.mjs` gains real-stack steps: create a task with a
description containing a heading and a list, reopen it and assert the read
view rendered them; add a label through the create row and assert the card
shows it; post a comment and assert it renders with the signed-in person's
name; upload a file through the Attachments section and assert the row and
the download; open Settings → Labels, rename, and assert the pill on the
card follows. On the phone context: open Task details (today's suite never
does), assert the stacked order and add a label.

Every screenshot is looked at, not just taken: the wave 3 report names what
each shows.

### 6.6 Documentation that changes with the code

- New `docs/standards/ticket-activity.md`: the invariants a later change
  must not break — one upload door and link doors, the `taskId` ACL arm,
  the inline-image URL form, comments belong to their author, source-owned
  vs Nessie-only labels, the per-provider comment audience rule, and the
  three agent surfaces mirroring one function. `AGENTS.md` → Architecture
  gets a one-sentence signpost beside the boards bullet.
- `CLAUDE.md` gains the `test:e2e:task-dialog` bullet in the browser-coverage
  list (fixture flag, CI placement, what it pins).
- `docs/plans/2026-09-05-project-boards-external-sources-and-custom-fields/as-built.md`:
  §5.3 comments superseded by §4.3 here; labels are `native:labels`; Linear
  webhook resource types; the `uploads.linear.app` live result.
- `docs/plans/2026-09-06-nessie-mcp-server.md`: the tool table gains the
  §3.1 rows.
- `docs/standards/tool-categories.md`: the sentence claiming `nessie_sheet_*`
  declares a category is corrected to say the MCP definitions carry none.
- This folder's own `overview.md` gets a **Status: built** line and an
  as-built section listing deltas, in the wave 3 turn.

### 6.7 Risks, and the default each proceeds on

| Risk | Default |
|---|---|
| `@tiptap/markdown` API names differ from `getMarkdown` / `setContent(…, { contentType: 'markdown' })` at 3.31 | B reads the package's typings first and keeps the `MarkdownEditor` contract; the round-trip test is the acceptance, not the method names |
| The pin bump changes the knowledge editor's behaviour | the knowledge suites are in B's gate; a regression blocks the wave |
| Linear's uploads host refuses the authorization header | assets go `failed`, text keeps the Linear URL, recorded in as-built; nothing else depends on it |
| The comment lane plus 100-issue pages exceed Linear's complexity budget | page sizes are constants in `queries.ts`; halve them, never nest comments in the items page |
| `Dialog size="full"` is not a viewport-filling panel | the one-line `xl` width change, verified across adopters (§5.13) |
| `TaskRecord` gaining required fields breaks cast fakes across the repo | wave 0 fixes every fake before parallel work starts; it is the reason wave 0 exists |
| Two agents both need `packages/team-admin/src/index.ts` | A owns it in wave 1 and exports C's modules by name given in this plan; C reports rather than edits |
