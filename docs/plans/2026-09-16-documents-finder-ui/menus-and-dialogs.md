# Documents as a Finder — menus and dialogs

Part of [the Finder plan](overview.md). The context-menu primitive, the five
menus item by item with enablement and copy, and every dialog the menus and
the toolbar open. Copy in quotes is exact; `{…}` is interpolated.

## 1. The `ContextMenu` primitive

New, `admin/src/components/overlays/ContextMenu.tsx` + `useContextMenu.ts`.
There is no right-click menu anywhere in the admin today (`onContextMenu`
appears once, in `ReactionPills`), so this is a shared primitive, not a
Finder component. It composes `Popover` (docs/navigation §7) on `split` and
`Sheet side="bottom" size="auto"` on `single`, decided by
`useNavigationLayout()`, never by width.

```ts
export type ContextMenuItem =
  | { kind: 'item'; id: string; label: string; icon?: IconDefinition; shortcut?: string;
      disabled?: boolean; disabledReason?: string; destructive?: boolean; onSelect: () => void }
  | { kind: 'radio'; id: string; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string } // a non-interactive caption, used once (the access read-out line)

export type ContextMenuAnchor =
  | { kind: 'point'; x: number; y: number }            // the pointer
  | { kind: 'element'; ref: RefObject<HTMLElement | null> } // the focused row (keyboard)

type ContextMenuProps = {
  anchor: ContextMenuAnchor | null   // null = closed
  items: ContextMenuItem[]
  label: string                      // accessible name, e.g. "Actions for Lease.pdf"
  onClose: () => void
  // Focus returns here on close; the row that opened the menu.
  returnFocusRef: RefObject<HTMLElement | null>
}

// The hook a host uses on its rows and its empty background.
export const useContextMenu = (): {
  anchor: ContextMenuAnchor | null
  openAt: (event: ReactMouseEvent | ReactPointerEvent) => void   // preventDefault + point anchor
  openFor: (element: HTMLElement) => void                       // keyboard: element anchor
  close: () => void
  // Spread on the trigger surface: onContextMenu, onKeyDown (Shift+F10 /
  // ContextMenu key), and the long-press pointer handlers.
  triggerProps: HTMLAttributes<HTMLElement>
}
```

Behaviour, all of it:

- **Opening.** `onContextMenu` → `preventDefault()` and a point anchor at
  `clientX/Y` (the native menu never shows over a row or the column body).
  Shift+F10 and the `ContextMenu` key on a focused row → an element anchor
  (the row's rect, placement `bottom-start`). On `single`, a long-press —
  `pointerdown` then 500 ms without `pointerup` and without moving more than
  8 px — opens the Sheet; `pointercancel`, scroll or movement cancels; the
  `click` that follows a completed long-press is swallowed once so the row
  does not also open.
- **Placement.** A point anchor is a zero-size `anchorRect` handed to
  `Popover`, which places through the one `placePopover` (preferred
  `bottom-start`, flips to `top-start` at the bottom edge, clamps inside
  `viewportBounds()` with its 8 px gutter). Nothing here places itself.
- **Layer and Back.** The popover kind (`--layer-popover` 50) on `split`; the
  Sheet kind (60) on `single`, where it owns Back so the hardware button
  closes it. A menu opened over a `Dialog` (none is, today) would pass
  `layer="modal"`.
- **Focus.** On open, focus moves to the first enabled item (a menu is the
  one popover role that takes focus — WAI-ARIA menu button pattern). ↑/↓
  move and wrap; Home/End; a printable character jumps to the next item
  starting with it; Enter and Space activate; Escape closes; Tab closes (a
  menu is not a tab stop). On close, focus returns to `returnFocusRef`
  (the row) or, if that row is gone (deleted), to the column body.
- **Outside press** closes through `Popover`'s own `mousedown`/`touchstart`
  listener; a right-click elsewhere closes this one and opens the other in
  the same gesture (the host calls `openAt` after `close`).
- **Roles.** Panel `role="menu"` `aria-label={label}`; items
  `role="menuitem"`, radios `role="menuitemradio"` `aria-checked`;
  separators `role="separator"`; a disabled item keeps focusability with
  `aria-disabled="true"` and its `disabledReason` on `title` so a keyboard
  user learns *why* (design-system: offering an edit the server will refuse
  is the failure; explaining why it is greyed is the cure).
- **Paint.** Panel `bg-[color:var(--panel)] border border-[color:var(--sep)] shadow-[0_16px_40px_var(--scrim-strong)] rounded-[var(--radius-md)] py-1 min-w-[220px]`
  (the same panel the account and create menus use). Item: 36 px row
  (44 px on `coarsePointer`), `px-3`, `text-sm --tx`, icon 16 px `--tx3`,
  shortcut right-aligned `text-xs --tx3`. Hover/focus item:
  `bg-[color:var(--accent)] text-[color:var(--on-accent)]` (Finder's
  highlight). Destructive item: `text-[color:var(--danger-text)]`, hover
  `bg-[color:var(--danger)] text-[color:var(--on-accent)]`. Disabled:
  `opacity-50`, no hover paint (guarded `:not([aria-disabled="true"])`).
- **No submenus.** Every menu below is flat; "Sort by" lives in the toolbar.
  *Rejected:* nested menus — a hover-intent timer on desktop and no gesture
  at all on touch.
- **Tests.** `admin/test/context-menu.test.ts`: opens on contextmenu with
  `preventDefault`, opens on Shift+F10 anchored to the row, first item
  focused, arrow wrap, type-ahead, Escape restores focus, long-press opens
  the Sheet on `single`, a disabled item is focusable and announces its
  reason; `overlay-portal.test.ts` and `dialog-adopters.test.ts` pick it up
  as a `useOverlay` consumer through `Popover`/`Sheet` automatically.

## 2. The menus

`FinderContextMenus.tsx` builds the item list from
`(target, selection, capabilities)` and is a pure function
(`buildFinderMenu`), unit-tested for every row of the tables below.
Capabilities come from the space record (`canWrite`, `canManageAccess`,
`metadata.personal && userId === me`), the row (`kind`, `status`,
`shareCount`, `indexing`) and the column (`virtual`, `root`).

Shortcuts shown on `split` with a fine pointer: ⌘ on macOS, Ctrl elsewhere
(`navigator.platform` once, in `lib/platform.ts`, which exists for the
composer's send hint).

### 2.1 A folder row

| Item | Enabled when | Copy | Does |
|---|---|---|---|
| Open | always | "Open" | opens the column (Enter) |
| — | | | |
| Get Info | always | "Get Info" `⌘I` | §3 |
| Sharing… | see §4 | "Sharing…" | §4 (share dialog or read-out) |
| — | | | |
| New folder inside | `canWrite` | "New folder inside" | opens the folder and drops `NewFolderRow` there |
| Rename | `canWrite` | "Rename" `F2` | inline rename |
| Move to… | `canWrite` | "Move to…" | §7 |
| — | | | |
| Copy link | always | "Copy link" | copies `${origin}/knowledge-base/spaces/${spaceId}?folder=${id}`; toast "Link copied" |
| — | | | |
| Delete… | `canWrite` | "Delete…" (destructive) | §8 |

A task folder (`taskId`) adds, after Get Info: "Open ticket" → the ticket's
board route (`/projects/:projectId/board?task=:taskId`).

### 2.2 A document row

| Item | Enabled when | Copy | Does |
|---|---|---|---|
| Open | always | "Open" | the document pane |
| Open in editor | `canWrite && kind === 'document'` | "Edit" | `openEdit(page)` (the `knowledge:editor` stage) |
| — | | | |
| Get Info | always | "Get Info" `⌘I` | §3 |
| Sharing… | §4 | "Sharing…" | §4 |
| Version history | always | "Version history" | `openHistory(id)` |
| — | | | |
| Publish | `canWrite && status === 'draft' && actor is a person` | "Publish" | existing `publishPage` (the human publish; the agent path stays the approval) |
| Rename | `canWrite` | "Rename" `F2` | inline |
| Move to… | `canWrite` | "Move to…" | §7 |
| — | | | |
| Copy link | always | "Copy link" | `…/spaces/${spaceId}?pageId=${id}` |
| — | | | |
| Delete… | `canWrite` | "Delete…" (destructive) | §8 |

A row whose `indexing.state === 'failed'` adds "Retry indexing" after Version
history (`canWrite`), calling `POST /reindex`.

### 2.3 A file row

As 2.2 with: no "Edit" (a Markdown file's Edit lives in `FileNodeViewer`'s
own header where it already is); "Download" `⌘⇧S` after Open →
`versionDownloadPath(pageId, currentVersionId)` in a new tab; "Upload new
version…" after Version history when `canWrite` → the existing
`FileVersionUploadDialog` (converted to the shared `Dialog` shell in the same
wave, closing the audit's worst offender). "Retry indexing" as 2.2.

### 2.4 A virtual row (Latest, Shared with me)

Same as the row's kind above, with two changes: **"Show in folder"** replaces
"Open in editor"/"New folder inside" as the second item — it navigates to
`/knowledge-base/spaces/${home.spaceId}?folder=${parentPath.at(-1)?.id ?? ''}`
and selects the row there (`?pageId=` intent is not used, because that opens
the document; a `?select=` state param is not added either — the Finder
selects the row by id after the column loads, from a one-shot ref, so the
URL stays an address). **New folder inside** is absent (it needs a position
in a folder); **Move to…** stays, acting on the row's real home (a foreign
target becomes a transfer — [transfer.md](transfer.md) §1).

In Shared with me a row the viewer does not own is shaped by its `access`:

| Item | `view` | `edit` |
|---|---|---|
| Open, Download, Get Info, Sharing… (the §4.5 read-out), Version history, Copy link | yes | yes |
| Edit (document) / Upload new version… (file) | — | yes |
| Rename | — | yes |
| New folder inside / New document inside (a shared **folder**) | — | yes |
| Publish, Move to…, Delete… | — | — (owner only) |
| Remove from Shared with me (destructive) → `DELETE /shares/:pageId/:me`, confirm "Remove “{title}” from Shared with me? {Sharer} can share it again." / "Remove" | yes | yes |

The row's subtitle in Shared with me reads "{Sharer} · Can view" or
"{Sharer} · Can edit".

### 2.5 The empty background of a column

| Column | Items |
|---|---|
| a folder column, `canWrite` | "New folder" `⌘⇧N` · "New document" · "Upload files…" · — · "Get Info" (the folder or root folder itself) · "Sharing…" (§4) · — · "Paste" is absent (no clipboard model) |
| a folder column, read-only | "Get Info" · "Sharing…" |
| the root column | "New shared folder…" (opens `CreateSpaceDialog`, title "New shared folder") · — · "Refresh" |
| a virtual column | "Refresh" only |

"Refresh" invalidates the column's query; it exists because a virtual list
has no other way to ask again.

### 2.6 A root row

My Documents: "Open" · — · "Get Info" (space info) · "Sharing…" (§4, the
personal read-out line). A project: "Open" · "Open project" (→
`/projects/:id`) · — · "Get Info" · "Sharing…" (§4 project read-out). A
shared folder: "Open" · — · "Get Info" · "Sharing & settings…" (`SpaceSettingsDialog`,
enabled `canManageAccess || canWrite`) · "Rename" (`canWrite`) · — ·
"Delete…" (`canWrite`; archives the space through `DELETE /spaces/:id` with
the confirm in §8's space form). An agent home: "Open" · "Open agent" · — ·
"Get Info" · "Sharing…" (§4 agent read-out). Dashboards and product views:
"Open" only.

### 2.7 A multi-selection (2+ rows)

"Get Info" (an aggregate: §3 with `n` targets summed client-side from `n`
info reads, capped at 20 — beyond that the dialog says "Select up to 20
items to see combined info") · "Download" (files only, one tab each, capped
at 10) · "Move to…" (`canWrite`) · — · "Delete…" (`canWrite`).

## 3. Get Info

`GetInfoDialog.tsx` — a `Dialog size="sm"` titled with the item's name,
fed by `usePageInfo`/`useSpaceInfo` ([data-and-api.md](data-and-api.md) §5).
A `Dialog`, not a `Sheet`: Get Info is a glance you dismiss, with no edit in
it; a drawer is for a task that stays open beside the work (the attachments
drawer). *Rejected:* an inline inspector column (Finder's preview pane) — the
rightmost region is the document pane, and two panes competing for it is the
nesting the design system forbids.

Layout: the icon at 40 px with the family tone, the name as the dialog's
`h2`, then a `<dl>` of key–value rows (`grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm`,
keys `--tx3`, values `--tx`). Rows, in order, with exact keys and value
formats:

| Key | Value | Shown for |
|---|---|---|
| Kind | `familyLabel` ("Folder", "Document", "PDF document", "Word document", …) or "Shared folder" / "Project folder" / "Your documents" / "Agent documents" for a space | all |
| Size | `formatBytes(sizeBytes)`; folders/spaces append " for {counts.total} items" | all |
| On disk | `formatBytes(storageBytes)`; when `retainedVersions > 0` append " including {n} earlier {version\|versions}" | when `storageBytes !== sizeBytes` |
| Contains | "{folders} folders, {documents} documents, {files} files" (zero groups omitted; "Nothing yet" when all zero); `truncated` appends " (counted up to 10,000 items)" | folders, spaces |
| Where | the home line: "{root} › {a} › {b}" with each segment a link that browses there; the root segment is "My Documents", the project name, the space name or "{Agent} — Documents" | all pages |
| Ticket | the ticket title, linking to the board | task folders |
| Created | `formatDateTime(createdAt)` + " by " + `<ActorName id={createdBy} />` | all |
| Modified | `formatDateTime(updatedAt)` | all |
| Search | one of: "Searchable" · "Indexing…" · "Preparing search…" · "Not indexed — draft documents are indexed when published" · "Not indexed — {familyLabel}s aren't searchable" · "Not indexed — larger than 20 MB" · "Not indexed — no text found" · "Indexing failed" with a "Retry" button beside it (`canWrite`); for folders and spaces "{indexed} searchable, {pending} indexing, {notIndexed} not indexed" | all but folders with nothing inside |
| Sharing | the sentence from §4 for the item's access mode, then for `personal` with `shareCount > 0` a list of grantees (`UserAvatar` 20 px + name + "Can view"/"Can edit"), with a "Share…" footer button opening §4.1 where levels are changed | all |

Footer: a "Share…" button (secondary) when `access.mode === 'personal' && canShare`;
"Sharing & settings…" (secondary) when `mode === 'space' && canManageAccess`;
"Done" (primary) closes. Loading: `QueryState` loading line "Reading…";
error: "Couldn't read this item's details." with Retry.

Multi-selection: title "{n} items", Size and On disk and Contains summed,
Where "in {folder}", the other rows omitted.

## 4. Sharing — the two cases, and the others

`buildFinderMenu` shows one item labelled "Sharing…" on every row and root
row; what it opens depends on `access.mode` (read from the info endpoint,
or known locally from the space record before the click so the menu never
promises the wrong dialog):

### 4.1 A personal document (mode `personal`, `canShare`) — the Share dialog

`ShareDialog.tsx`, `Dialog size="sm"` titled "Share “{title}”". Body:

1. A sentence under the title, `text-sm --tx2`: "People you add can open,
   read and download this {document|file|folder and everything inside it}.
   Give someone editing to let them change it — they still can't share,
   move, publish or delete it. They get it straight away; nobody has to
   approve it." This is the no-approval statement and the edit boundary,
   on screen, every time.
2. A people picker: a searchable combobox in the shape of `AssigneePicker`
   (people only — a new `PersonPicker` in `components/shared/` built from
   the same list/combobox code with agents removed, since sharing with an
   agent is not offered), options from `useUsers` locally or
   `useTeamMembers` under UOA exactly as `SpaceSettingsDialog` builds them,
   excluding the viewer and existing grantees. Placeholder "Add a person…".
   Beside it a level control — `TabBar role="radiogroup"` with "Can view" ·
   "Can edit", default "Can view", a form field and therefore `useState`
   (docs/navigation §1's form-field exception, recorded in
   `tab-param.test.ts`'s allowlist). Picking a person calls `POST /shares`
   with the chosen `access` immediately and adds them to the list below —
   no Save button; the dialog is the state.
3. "Has access" — `SectionLabel size="sm"`, then rows: `UserAvatar` 20 px,
   name, and a level button `"Can view ▾"` / `"Can edit ▾"` that opens a
   `Popover role="menu"` with `menuitemradio` "Can view" · "Can edit" and a
   separator then "Remove" (destructive). Choosing a level calls
   `PATCH /shares/:granteeUserId`; Remove calls `DELETE`. The first row is
   always the owner: "{You} — Owner", no button. Empty: "Only you, so far."
4. Below the list, `text-xs --tx3`: "Shared documents open from the
   recipient's Shared with me. Shared pages are not included in the
   recipient's search, whatever their access."
5. Footer: "Copy link" (secondary; copies the `?pageId=` link, which works
   for a grantee) · "Done" (primary).

Errors from `POST`/`PATCH` land in a `FormError` under the picker with the
server message; the picker keeps focus. A `SHARE_SOURCE_RESTRICTED` answer
reads "This document contains material {name} cannot be shown" and the
person is not added. Changing a level is optimistic and reverts on error.

For a shared **folder** the dialog's first sentence ends "…this folder and
everything inside it, including what is added later."

### 4.2 Project documents (mode `project`) — the read-out

`AccessReadoutDialog.tsx`, `Dialog size="sm"` titled "Who can see this".
Body, exact:

> **Everyone in the project {Project name} can see this.**
> Access follows the project's membership. To change who can see these
> documents, add or remove people in the project — there is no separate
> sharing for a project's documents.

Then "In the project" (`SectionLabel`), the member list from
`GET /api/projects/:projectId/members` (`UserAvatar` + name, every member
listed, the viewer marked "(you)"), with a loading line "Reading members…"
and, above 50 members, "and {n} more" after the first 50. Footer: "Open
project members" (secondary → `/projects/:id?tab=members` or the project's
members surface as it exists) · "Done". Nothing in this dialog writes.

### 4.3 A shared folder's page (mode `space`)

Title "Who can see this". Sentence by visibility:

- `organization`: "**Everyone in the organisation can see this.** It is in
  the shared folder {space}."
- `project`: "**Everyone in the project {project} can see this.** It is in
  the shared folder {space}."
- `team`: "**Everyone on the team can see this**, plus the people added to
  the folder {space}."
- `channel`: "**Everyone in the channel can see this**, plus the people
  added to the folder {space}."
- `private`: "**Only people added to the folder {space} can see this.**"

`writeRestricted` appends: " Editing is restricted to the people listed."
Then "Added to this folder": the `memberUserIds` resolved to names, and
"Agents with access" if any. Footer: "Sharing & settings…" (secondary,
`canManageAccess` — opens `SpaceSettingsDialog`, today's edit surface,
which also gains the missing **visibility** control: a `ChoiceGroup` over
the five values, writing `visibility` through `PATCH /spaces/:id` — the
Rule-zero gap the brief named, closed while the dialog is open anyway) ·
"Done".

### 4.4 An agent home (mode `agent`)

Sentence: "**People who can see the agent {name} can see its documents.**
{n} {person|people} were also added directly." Footer: "Open agent" ·
"Sharing & settings…" (`canManageAccess`) · "Done".

### 4.5 A shared-with-me row (mode `shared_to_me`)

Sentence by level — `view`: "**{Sharer} shared this with you.** You can
read it and download it; only {Sharer} can change who has access." `edit`:
"**{Sharer} shared this with you and you can edit it.** Your changes are
saved as new versions under your name; only {Sharer} can publish it, move
it, delete it or change who has access." Footer: "Remove from Shared with
me" (destructive, §2.4's confirm) · "Done".

### How the UI tells the cases apart before the click

The menu label is the same word — "Sharing…" — everywhere, so nobody hunts
for a "Share" that is not there; the dialog title differs: "Share “{title}”"
only when the viewer may actually grant. The row of a personal document
carries the `faUserGroup` glyph once shared. The root row of My Documents
carries no glyph: sharing is per item.

### The gate that is not involved

The share path never creates an `Approval`, never routes through
`approval-effects.ts`, never shows the `AgentDraftBadge` and never appears
under "Needs review". Those belong to `knowledge.page.publish`, the agent
publication gate ([data-and-api.md](data-and-api.md) §2). An implementer
wiring the share into that queue has misread the ask.

## 5. New folder

Inside a folder column: today's `NewFolderRow` at the top of the active
column; Enter creates (`POST /spaces/:id/pages` with `kind: 'folder'`,
`parentPageId`), Escape cancels, blur with a name creates. A duplicate name
is allowed (Finder appends nothing; the server does not enforce uniqueness).
In the root column: `CreateSpaceDialog` retitled "New shared folder", its
visibility `ChoiceGroup` kept, "Create". After creation the new root row is
selected and opened.

## 6. New file

`NewFilePicker.tsx` — the `Popover role="menu"` off the primary "New file"
button (`placement="bottom-end"`), items from `new-file-types.ts`:

```ts
export type NewFileType = {
  id: 'document' | 'upload' | (string & {})   // open for a future kind
  label: string           // "Document" | "Upload…"
  description: string     // second line, text-xs
  icon: IconDefinition
  // What the picker invokes. Every seam already exists or is named here.
  invoke: (ctx: { spaceId: string; parentPageId: string | null; openCreate; openPagePath; openUploadPicker }) => void
}
export const NEW_FILE_TYPES: NewFileType[] = [
  { id: 'document', label: 'Document', description: 'A page you write here', icon: faFileLines,
    invoke: ({ parentPageId, openCreate }) => openCreate(parentPageId) },
  { id: 'upload', label: 'Upload…', description: 'Files from your computer', icon: faCloudArrowUp,
    invoke: ({ openUploadPicker }) => openUploadPicker() },
]
```

**Spreadsheets are deliberately not here.** The owner wants that work left
alone until it is done; this design carries no spreadsheet kind and no
import from any spreadsheet branch. The seam is this array: a future
integrator adds one entry `{ id: 'spreadsheet', label: 'Spreadsheet', … }`
between the two, whose `invoke` opens whatever creation dialog that work
ships, and the picker gains its third row. In a build without it the item is
**absent**, not disabled — a greyed "coming soon" would be a promise the
build cannot keep. *Rejected.*

Naming: **Document** opens the editor (`knowledge:editor` stage) in create
mode with the active folder as parent; the title is typed there, where it
already is edited in place. *Rejected:* creating "Untitled" on the server and
renaming inline — a blank page would exist before a word is written, appear
in Latest, and fill Needs review for agent drafts. **Upload…** opens the
hidden `<input type="file" multiple>`; naming is the filename.

## 7. Move to…

`MoveToDialog.tsx`, `Dialog size="md"` titled "Move {n} {item|items} to…".
Body: a folder tree of **every root folder the person can write** — My
Documents, each project, each writable shared folder — each root a top-level
row (its icon from [browser-ui.md](browser-ui.md) §3) expandable to its
folders (folders only, `faChevronRight` disclosure, the current folder
marked "(current)" and disabled, descendants of a moving folder disabled
with `title="Can't move a folder into itself"`). The item's own root is
expanded on open. Footer while the picked target is in the same root:
"Cancel" · "Move" (primary, enabled when a target differs from the current
parent), calling `useMovePages`. The moment a target in another root is
picked the title becomes "Move or copy {n} {item|items}…", the audience and
sharing lines from [transfer.md](transfer.md) §1 appear above the footer,
and the footer becomes "Cancel" · "Copy here" · "Move here" (two
secondaries, no primary), calling `useTransferPages` with the chosen
operation. A refusal from [transfer.md](transfer.md) §4 replaces the two
buttons with its sentence and "OK".

## 8. Delete

`ConfirmDialog destructive` — the shared confirm; no Finder-specific dialog.

- One item: title "Delete “{title}”?", body by kind — folder: "Everything
  inside it will be deleted too. Uploaded files are removed from storage
  straight away." · document: "Its versions and comments are
  removed." · file: "Its {n} {version|versions} are removed from storage
  straight away." Confirm label "Delete".
- Multi: "Delete {n} items?", body "Uploaded files inside them are removed
  from storage straight away." Confirm "Delete {n} items".
- A shared folder (space) root row: "Delete the shared folder “{name}”?",
  body "Everything in it is deleted for everyone who could see it." Confirm
  "Delete folder".

What it does: `DELETE /pages/:id` per item (archive + file purge — the
existing route), or `DELETE /spaces/:id`. The word is "Delete" because that
is what happens to the bytes; there is no Trash to restore from
(overview → decision 13). A shared item warns one line more: "It is shared
with {n} {person|people}, who will lose access."

## 9. Toasts and small copy

| Moment | Copy |
|---|---|
| Copy link | "Link copied" |
| Rename conflict | "This item changed since you opened it. Refresh and try again." |
| Transfer done (sync) | "Moved {n} {item\|items} to {target}" / "Copied {n} {item\|items} to {target}" |
| Transfer queued | none — the status-bar tray shows progress ([transfer.md](transfer.md) §5) |
| Share added / level changed | none (the row reflects it) |
| Reindex requested | "Indexing again…" |
| Project space provisioned on first open | none (the folder simply opens) |
| Root truncated (status bar, not a toast) | "Showing 200 of {n} shared folders — use search to find the rest" |
