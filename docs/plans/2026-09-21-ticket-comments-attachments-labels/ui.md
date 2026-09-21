# UI

Part of [ticket comments, attachments and labels](overview.md).

## 5. UI, to the element

### 5.1 Owning surface and doorways (Rule zero)

| Capability | Owning surface | In-context doorways |
|---|---|---|
| Description, Documents, Attachments, Comments | the ticket dialog — `TaskDialog`, opened by `?task=` on the board, by Search results, by chat ticket links (all unchanged) | the card itself; the card's comment/paperclip counts |
| Labels on a ticket | the dialog's **Labels** field (right column) | label pills on the card |
| Label management | `/projects/:projectId/settings?section=labels` (`LabelsSettingsSection`) | the token dropdown's footer row **Manage labels…**; the settings strip; the *Create label "x"* row creates one without leaving the ticket |
| The same for agents | §3 | — |

Names the browser suites already depend on stay: dialog `Task details` /
`New task`, textbox `Title`, label `Column`, buttons `Save changes`, `Create
task`, `Close`, tab `Checklist`. The description's accessible name changes
from `Detail` to **`Description`**, and the two suites that fill it
(`admin/e2e/project-usability/run.mjs` `createTask`,
`admin/e2e/ticket-search/run.mjs`) change with it in the same wave.

### 5.2 Dialog anatomy

`Dialog size="xl"`, title, `dismissDisabled={pending}`, `initialFocusRef`
on Title — unchanged. Then, in edit mode, the external-link `Notice` and the
Details/Checklist `TabBar` — unchanged. The Details form is one `<form>`
laid out as **three groups whose DOM order is the phone order and whose grid
placement is the desktop layout**:

```
<form class="task-dialog-form">           grid; md+: grid-template-columns 1.7fr 1fr, two rows
  <div class="task-dialog-head">          md+: column 1, row 1
    Title · Excerpt
  <div class="task-dialog-meta">          md+: column 2, rows 1-2
    Priority · Assignee · Deadline · Column · Labels · custom Fields · (Project, create mode only)
  <div class="task-dialog-body">          md+: column 1, row 2
    Description · Documents · Attachments · Comments
  Notice(error) · TaskDialogActions       md+: both columns
```

Below `md` the groups stack in that order — short controls first, long
content after — with no `order:` tricks. Sections inside a group are
separated by spacing and a `SectionLabel`, never a bordered box (the
no-nesting rule; `TaskDocuments`' `rounded-md border` wrapper goes).

**Save model is unchanged for form fields**: Title, Excerpt, Description,
Priority, Assignee, Deadline, Column, Labels and custom fields ride the
`useDraft<TaskDraft>` and commit on **Save changes** / **Create task**.
`TaskDraft` gains `labelIds: string[]` and `pendingAttachmentIds: string[]`.
**Comments and Attachments are immediate** — their own mutations, like
Documents today — and exist only in edit mode (`isEdit && task`); in create
mode the body group holds the Description alone.

`handleSubmit` order becomes: `updateTask` (title, purpose, detail, priority,
dueDate, fieldValues patch, **labelIds when changed**, **attachmentIds when
pending**) → `assignTask` → `moveTask` → clear draft → close. Create sends
`labelIds` and `attachmentIds` in the one `POST`.

### 5.3 Description — read view ↔ editor

`TaskDescriptionField` (`components/features/projects/kanban/TaskDescriptionField.tsx`):

- `SectionLabel` **Description** with, on the right, an icon button
  `aria-label="Edit description"` (`faPen`) in read mode, or a secondary
  compact **Done** button in edit mode. Create mode starts in edit mode with
  no toggle (there is nothing to read yet).
- **Read view**: `MessageMarkdown` with the new prop
  `resolveAttachmentImages` (below), inside `.admin-message-markdown`; empty
  → muted *No description yet.* Clicking anywhere in the read view also
  enters edit mode (`role="button"`, keyboard: Enter), because a pencil alone
  is a small target.
- **Editor**: `MarkdownEditor` (shared, §5.8) with `ariaLabel="Description"`,
  placeholder *Describe the work — paste or drop images to include them.*
  **Done** returns to the read view rendering the draft; nothing is saved
  until **Save changes**. Escape keeps its dialog meaning (close); the draft
  survives, as it does for every field today.
- **Images**: toolbar **Image** (hidden `<input type="file" accept="image/*" multiple>`),
  paste of clipboard files, and drop onto the editor all call
  `onUploadImage(file)`. While uploading the editor shows a placeholder node
  (`data-uploading`, a `Skeleton` block with the filename and a progress
  bar from `UploadProgress.pct`); on success it is replaced by an image node
  whose `src` is `/api/attachments/<id>`; on failure the placeholder is
  removed and a `Notice tone="danger"` under the editor names the file and
  the reason (`formatBytes` limit 25 MiB, `SECRET_INTERCEPTED`, network).
  In **edit mode** the upload is `POST /api/uploads` then
  `POST /api/tasks/:taskId/attachments { attachmentIds }` at once, so the
  file is on the ticket even if the person closes without saving. In
  **create mode** the id is pushed to `draft.pendingAttachmentIds` and linked
  by the create call.
- Read-only mirrored ticket: the description is source-owned already
  (title/detail write back); nothing changes — the read view has the pencil,
  the save refuses as today.

`MessageMarkdown` gains `resolveAttachmentImages?: boolean`. When set, its
`img` component override renders `AuthedAttachmentImage` for a `src`
matching `INLINE_ATTACHMENT_PATH` (resolved through
`useAuthedObjectUrlFromPath(path, token)`, `loading="lazy"`, `alt` kept, a
`Skeleton` while resolving, the placeholder *Image removed* on 404) and
falls back to today's behaviour for any other `src`. `TaskChecklistTab`,
chat and every other caller are untouched because the prop defaults off.

### 5.4 Documents

`TaskDocuments` keeps its hooks and rows. Changes: the outer `rounded-md
border … p-3 md:col-span-2` wrapper becomes a plain `grid gap-2`; the header
row is `flex flex-wrap items-center gap-2` so *Upload file · New spreadsheet
· New note* wrap on a phone instead of overflowing; `SectionLabel` stays.
It renders directly under the description in `.task-dialog-body`.

### 5.5 Attachments

`TaskAttachmentsSection` (`kanban/TaskAttachmentsSection.tsx`), edit mode
only:

- Header: `SectionLabel` **Attachments** (with the count when > 0) and a
  secondary compact **Upload file** button (`<input type="file" multiple>`).
  The whole section is a drop target (`useFileDrop` + `DropZoneOverlay`,
  the composer's own pair) reading *Drop files to attach*.
- Rows (a `RowList`-style list, no borders): 40 px thumbnail through
  `attachmentThumbnailPath` + the authed hook, or the kind glyph; filename
  (truncated, `title` full); `formatBytes(sizeBytes)`; who — `UserAvatar` +
  `ActorName` for a person, `AgentAvatar` for an agent, the provider glyph +
  *From Linear* for an import — and relative time (`title` exact); a
  `Pill size="sm" tone="muted" uppercase={false}` **in description** / **in
  comment** when `inline`; actions on the right: **Download** (icon,
  `downloadAuthedPath`) and **Remove** (`faXmark`, `aria-label="Remove
  <filename>"`) shown only when the viewer may remove. Clicking the row opens
  `AttachmentViewer` for images and PDFs, downloads otherwise.
- Uploading rows: the same row shape with a progress bar and **Cancel**
  (`UploadAbortedError` discards through `useDiscardAttachment`).
- External rows: `status: 'link'` → an outbound-link glyph, the title, the
  host, opens in a new tab with `noopener`; `status: 'failed'` → a warning
  glyph and *Couldn't copy from Linear* with **Open in Linear ↗**; neither
  has Remove (they belong to the sync).
- Remove of an `inline` file: `ConfirmDialog` *Remove "shot.png"? It is
  shown in the description; the image will read "Image removed".* / **Remove**.
- States: loading → two `Skeleton` rows; empty → *No files yet. Drop files
  here or upload.*; error → `Notice tone="danger"` *Couldn't load
  attachments.* with **Retry**.

### 5.6 Comments

`TaskCommentsSection` (`kanban/TaskCommentsSection.tsx` + `TaskCommentRow.tsx`
+ `TaskCommentComposer.tsx`), edit mode only, last in the body group:

- Header: `SectionLabel` **Comments** with the count.
- **Show earlier comments** (text button) above the list while
  `nextCursor` is set (`useInfiniteQuery`, oldest first, 50 a page).
- Row: avatar (`UserAvatar` / `AgentAvatar` / provider glyph tile),
  `ActorName` (which prints the kind word — *person*, *agent*), or the
  provider display name with *· Linear* for an external author; time
  (relative, `title` exact); *edited* after the time when `editedAt`; a
  `Pill size="sm" tone="muted" uppercase={false}` **Nessie only** when the
  ticket is mirrored and `external` is null, or the provider name as a link
  to `external.url` when imported; the body through `MessageMarkdown
  resolveAttachmentImages`; attachment chips under the body
  (`MessageAttachments`, the chat renderer); an overflow menu (`ContextMenu`,
  `aria-label="Comment actions"`) with **Edit** / **Delete** only when
  `viewerCanEdit` / `viewerCanDelete`.
- Edit in place: the body swaps for a `MarkdownEditor` seeded with the
  Markdown, **Save** (primary compact) / **Cancel**; Cmd/Ctrl+Enter saves.
- Delete: `ConfirmDialog` *Delete this comment?* / **Delete** (destructive);
  the row leaves the list.
- Composer, always last: `MarkdownEditor` in `compact` (two lines at rest,
  grows), placeholder *Write a comment…*; below it, left: **Attach**
  (paperclip, `<input type="file" multiple>`, staged chips with progress and
  ×, through `useComposerAttachments`' pattern against `/api/uploads`);
  right: **Post** (primary compact), disabled while empty or an upload is in
  flight; Cmd/Ctrl+Enter posts. On success the editor clears and the list
  scrolls to the new row; on failure a `Notice` under the composer names the
  reason and the text stays.
- Under the composer on a `read_only` mirrored ticket, a muted line: *This
  ticket mirrors Linear read-only. Comments stay in Nessie.*; on
  `read_write`: *Comments post to Linear as <connection owner>.*
- States: loading → three `Skeleton` rows; empty → *No comments yet.*;
  error → `Notice` + **Retry**. `task.activity` invalidates the list, so a
  colleague's comment appears without a reload.

### 5.7 Labels — the token field

`TaskLabelsField` (`kanban/TaskLabelsField.tsx`) in the meta group after
Column: `FieldLabel` **Labels**, then the generic `TokenInput` primitive
(`components/primitives/TokenInput.tsx`, §5.8) fed with the project's labels
(`useProjectLabels(projectId)`), the draft's `labelIds`, and `onCreate`
bound to `useCreateProjectLabel`. Behaviour, stated as the acceptance test:

- **Anatomy.** One field box styled as `.admin-input` with `flex-wrap`; the
  chosen labels render inside it as `LabelPill`s, each with a × button
  (`aria-label="Remove <name>"`); the text `<input>` sits after the last
  pill with `min-width: 8ch; flex: 1`, so the field grows line by line as
  pills wrap. `role="combobox"`, `aria-expanded`, `aria-controls` the
  listbox, `aria-activedescendant` the active row.
- **Dropdown.** A `Popover role="listbox" matchAnchorWidth` (modal-owned
  automatically inside `Dialog`) opens **on focus** and on typing, listing
  **every** label of the project: chosen ones first with a check mark
  (pressing toggles them off), then the rest, each row a `LabelPill` and the
  name. Typing filters by case-insensitive substring; the list never scrolls
  the page. Max height 40 vh, scrolls inside.
- **Create row.** When the trimmed text has no case-insensitive exact match,
  a row **Create label "x"** appears — first when nothing else matches, last
  otherwise. Choosing it calls `POST …/labels { name, color }` with the next
  palette colour (`LABEL_PALETTE[count % 12]`), adds the pill, keeps focus
  in the input and clears it; `LABEL_NAME_TAKEN` selects the returned
  existing label instead. Anyone who can change the ticket can create (any
  project member; the route's gate).
- **Keys.** `ArrowDown`/`ArrowUp` move the active row (wrapping); `Enter`
  selects the active row, or with no active row and no exact match, creates,
  or with an exact match, selects it; `,` behaves as Enter; `Backspace` on an
  empty input highlights the last pill, a second press removes it; `Escape`
  closes the popover and stops propagation only when it was open (a second
  Escape closes the dialog, as today); `Tab` closes and moves on. Mouse:
  clicking a row selects and keeps the popover open; clicking outside closes.
- **Footer row.** Below the listbox, outside it: **Manage labels…**, a link
  to `/projects/:projectId/settings?section=labels` (navigates, closes the
  dialog through the normal route change — `?task=` is dropped by the
  settings route, so nothing bespoke).
- **Mirrored ticket, `read_only`.** Source-owned pills (`external: true`)
  render with the provider glyph and no ×, `title` *Linear owns this label*;
  Nessie-only pills stay removable; the dropdown lists source-owned labels
  disabled with the same title, Nessie-only ones normally; the create row
  still works (it creates a Nessie-only label). `read_write`: everything
  enabled; a refused save surfaces the §4.6 sentence in the dialog's error
  `Notice`.
- **Custom `multi_select` fields** adopt the same `TokenInput` (no create
  row; the existing *Manage fields…* link stays), which retires the toggle
  wall in `TaskFieldControl` for every field, not only labels.

### 5.8 Shared primitives this adds

| Primitive | File | Contract |
|---|---|---|
| `TokenInput` | `components/primitives/TokenInput.tsx` (+ `token-input-keys.ts`, pure key handling with its own unit test) | `{ tokens: {id,label}[]; options: {id,label,disabled?,title?}[]; onAdd(id); onRemove(id); onCreate?(text) => Promise<{id}>; renderToken(token, remove); renderOption(option, active, selected); placeholder; ariaLabel; disabled; footer?: ReactNode; createLabel?(text) => string }` |
| `LabelPill` | `components/primitives/LabelPill.tsx` | `{ name; color: '#rrggbb'; size?: 'sm'\|'md'; external?: boolean; onRemove?; title? }`; paints `--label: <color>` inline and one `.admin-label-pill` rule in `styles.css`: background `color-mix(in srgb, var(--label) 16%, var(--surface))`, a 6 px dot in `var(--label)`, border `color-mix(in srgb, var(--label) 40%, transparent)`, text `var(--tx)` — contrast by construction on every theme, which is why colour-as-data is allowed here |
| `LabelColorPicker` | `components/shared/LabelColorPicker.tsx` | swatch button → `Popover role="dialog"` with the 12 `LABEL_PALETTE` swatches (`aria-label` names) and a hex `Input` validated by `LabelColorSchema` |
| `MarkdownEditor` | `components/shared/markdown-editor/MarkdownEditor.tsx` (+ `RichTextToolbar.tsx` extracted from the knowledge `RichTextEditor`, `AttachmentImageNode.tsx`, `markdown-editor-upload.ts`) | `{ value: string; onChange(markdown); onUploadImage?(file) => Promise<{ id }>; placeholder; ariaLabel; disabled; compact?; autoFocus? }`; Tiptap `useEditor` with `StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false, autolink: true } })`, `Image`, `Placeholder`, `Markdown` from `@tiptap/markdown`; content set with `contentType: 'markdown'`, `onUpdate` emits `editor.getMarkdown()`, an external `value` change re-seeds only when it differs from the current serialisation; `editorProps.handlePaste/handleDrop` route files to `onUploadImage`; the image node view resolves `INLINE_ATTACHMENT_PATH` through the authed hook |
| `RichTextToolbar` | shared with the knowledge editor | Bold · Italic · H2 · H3 · Bullet list · Numbered list · Quote · Code · Code block · Link (the existing `Popover` input) · **Image** (when `onUploadImage`); the knowledge editor keeps its wikilink button by passing an extra slot; `aria-pressed` on toggles, `aria-label`s, Cmd/Ctrl+B/I/K |

Every `@tiptap/*` in `admin/package.json` is pinned to **one** 3.31.x
version (`@tiptap/markdown` and `@tiptap/extension-image` peer-require an
exact core version), and the knowledge editor is re-verified after the bump
(`test:e2e:knowledge-markdown`, the editor unit tests). No vendored code, no
patches.

### 5.9 Cards

`KanbanCard`: up to three `LabelPill size="sm"` then `+N`, in the chip row
before custom-field chips (`CARD_FIELD_CHIP_LIMIT` counts both); in the meta
line, `faComment n` and `faPaperclip n` only when `n > 0` — a card with
discussion or material to read before picking it up is a different decision
from one without, which is what earns the glyph.

### 5.10 Label management — Project → Settings → Labels

`admin/src/pages/project/settings/LabelsSettingsSection.tsx`; `SECTIONS`
in `ProjectSettingsPage.tsx` becomes `['fields', 'labels', 'sources']`
(default stays `fields`); the `TabBar` reads *Fields · Labels · Sources*.

- Header row: **New label** (primary compact) opens an inline row-form at
  the top — name `Input`, `LabelColorPicker` (defaults to the next palette
  colour), **Add** / **Cancel**; Enter adds; `LABEL_NAME_TAKEN` shows
  `FormFieldError` *A label with this name exists.*
- Rows (`RowList`, ordered by name): `LabelPill`; the name as an inline
  editable — click or the pencil turns it into an `Input`, Enter saves,
  Escape cancels; `LabelColorPicker`; *n tickets* (from `taskCount`, singular
  handled, nothing shown at zero — "a tile carries what is in it"); for a
  source-owned label the provider glyph with *Linear* and the name input
  disabled with the `FieldLabel` hint *Linear owns the name; colour is
  yours*; **Delete** (icon, `aria-label="Delete <name>"`) → `ConfirmDialog`
  *Delete "Bug"? It comes off 12 tickets.* / **Delete label** (destructive).
- Non-modifiers see the rows read-only with the existing sentence *Only
  project members can change labels.* (the same voice `FieldsSettingsSection`
  uses).
- Empty: *No labels yet. Add one here, or type a new one on any ticket.*
  Loading: `QueryState` skeleton; error: `Notice` + **Retry**.
- Mutations invalidate `projectKeys.labels(projectId)` and `taskKeys.all`
  (cards repaint), and the server publishes `board.updated`.

### 5.11 States, in one place

| State | Description | Attachments | Comments | Labels |
|---|---|---|---|---|
| loading | read view renders the record's `detail` (already loaded with the task) | 2 skeleton rows | 3 skeleton rows | field disabled, placeholder *Loading labels…* |
| empty | *No description yet.* | *No files yet. Drop files here or upload.* | *No comments yet.* | placeholder *Add labels* |
| error | — | `Notice` + Retry | `Notice` + Retry | `Notice` under the field + Retry; pills from the draft still shown |
| uploading | placeholder block with progress | progress row + Cancel | staged chip with progress | — |
| create mode | editor open, no toggle | hidden | hidden | enabled |
| mirrored `read_only` | pencil shown; save refuses with the source sentence | Upload allowed (local) | composer allowed + *Comments stay in Nessie* | source-owned pills locked, Nessie-only editable, create allowed |
| mirrored `read_write` | as native | Upload allowed (local; not sent upstream) | composer + *Comments post to Linear as <owner>* | all editable; a refusal shows the §4.6 sentence |
| viewer cannot change the ticket (not a project member, org member on a public project reading it) | read view only, no pencil | list only, no Upload/Remove | list only, no composer, *You can read this ticket but not comment on it.* | pills only, field disabled |

The last row needs a fact the record does not carry today: `TaskRecord`
gains `viewerCanEdit: boolean` (derived server-side in `mapProjectTask`
from the same `listAccessibleProjectIds` rule the routes apply), which the
dialog reads instead of guessing from role.

### 5.12 Copy

Sentence case throughout; buttons are verbs; nothing says "integration",
"sync engine" or "data source". The strings above are the strings; the
refusal sentences come from the server (`describeWriteFailure` on the MCP,
the service's `detail` on the routes) and are shown verbatim in the dialog's
error `Notice`.

### 5.13 Phone (`single` layout)

- The dialog stays a `Dialog` (only a `Sheet` goes full-bleed on `single`,
  per the overlays chapter). `size="xl"` is `min(80vw, 1100px)`, which is a
  300 px panel on a phone; on `usePhoneLayout()` the dialog passes
  `size="full"` if `Dialog.tsx` renders that as the viewport-filling panel,
  and otherwise `xl` is widened in the shared shell to
  `min(100vw - 2 * var(--page-gutter), 1100px)` — one line in `Dialog.tsx`,
  re-verified on the other `xl` adopters (`dialog-adopters.test.ts`). No
  third option.
- Groups stack in DOM order (§5.2). The token popover opens **below** the
  field and is capped at 40 vh so the keyboard does not cover it; the
  editor toolbar wraps to two rows; every icon action is a 44 px target
  under a coarse pointer (the page-header rule, applied here through the
  same `(pointer: coarse)` media query on `.task-dialog-form`).
- The comment composer's **Post** sits on the same line as **Attach**; the
  Documents buttons wrap.
