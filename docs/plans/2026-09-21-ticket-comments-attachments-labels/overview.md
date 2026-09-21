# Ticket comments, attachments, labels and a Markdown description

**Date:** 2026-09-21 · **Status:** built (see §7 As built)
**Owning surface:** the ticket dialog (`TaskDialog`, opened by `?task=` on
`/projects/:projectId/board`) and Project → Settings → **Labels**
(`/projects/:projectId/settings?section=labels`).
**Builds on:** [project boards, external sources and custom fields](../2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
(read its [as-built](../2026-09-05-project-boards-external-sources-and-custom-fields/as-built.md) first),
[the Nessie MCP server](../2026-09-06-nessie-mcp-server.md),
[paired agents](../../standards/paired-agents.md),
[file storage](../../standards/file-storage.md).

This is the one document Opus implementers build from, in waves, without
re-deriving decisions. Every chapter is authoritative for its own area; this
page is the map, the decision table and the open questions. Section numbers
are stable across chapters.

## Table of Contents

- **[Data model](data-model.md)** — §1. Prisma models, the migration, the
  wire shapes in `@nessie/schemas`.
- **[API and services](api-and-services.md)** — §2. The shared
  `@nessie/team-admin` functions, the routes and their gates, attachment
  access, `TaskEvent` audit, realtime.
- **[Agent tools](agent-tools.md)** — §3. The `nessie_*` MCP tools and the
  `ticket_*` builtins that mirror the same functions.
- **[Import](import.md)** — §4. The adapter contract extension, Linear in
  full, the other three adapters, idempotency, failures, authors, write-back.
- **[UI](ui.md)** — §5. The dialog to the element: layout, the description
  editor, Documents, Attachments, Comments, the label token input, label
  management, states, copy, keyboard, phone.
- **[Delivery](delivery.md)** — §6. The contract wave, three implementation
  waves with exclusive file lists, gates, tests, browser checks, screenshots,
  and the documentation that changes with the code.

## 0. What was asked, and what is true today

Ondrej, verbatim in spirit: on any ticket on any board, comment and attach
files; the description is a rich-text editor that round-trips to Markdown and
takes images; labels are managed, entered through a growing token field with
typeahead, Enter-to-add, create-if-missing, and a dropdown showing all of
them; Documents sit directly under the description in the left column; Linear
(and any other source) imports comments, files and labels; and everything a
person can do here an agent can do through the tool surface.

Established by reading the code (chapter references say where):

- **T1 — there is no label, comment or attachment concept on a ticket.**
  `Task` has plain-text `purpose` and `detail`, `fieldValues` JSONB and a
  `TaskExternalLink`. Labels exist only as a `multi_select` custom field named
  *Labels* that a Linear/GitHub/Trello/Jira attach creates
  (`api/src/routes/board-sources/sources.ts:258-277`), and its control renders
  **every option as a toggle pill** (`TaskFieldControl.tsx:84-109`) — the wall
  in the screenshot. Native projects have no such field until somebody creates
  one.
- **T2 — files are one chokepoint and one ACL, with no ticket arm.**
  `FileService.store` (`packages/runtime/src/files/index.ts`) creates the
  `Attachment` row; `canAccessAttachment` (`api/src/services/attachments.ts:108`)
  answers by `messageId`, `emailMessageId`, knowledge page, uploader, or
  published asset. Downloads are bearer-authenticated, so a bare `<img src>`
  gets a 401; the admin resolves images through `useAuthedObjectUrlFromPath`
  (`admin/src/lib/uploads.ts:138`). Uploads that never get linked are never
  reaped.
- **T3 — the editor is Tiptap, HTML-backed, and there is no Markdown
  serializer.** `@tiptap/{react,starter-kit,pm,extension-placeholder}` ^3.26;
  the knowledge `RichTextEditor` emits HTML; Markdown renders through
  `react-markdown` + `remark-gfm` in `MessageMarkdown.tsx` with no raw HTML.
- **T4 — comments were kept out of the mirror on purpose** (§5.3 of the
  boards design): an upstream comment can have a narrower audience than its
  issue. §4.3 answers that per provider rather than waving it away.
- **T5 — three agent surfaces, none of which see labels, comments or files.**
  `nessie_board_*`/`nessie_task_*` on `POST /mcp` (`api/src/mcp/tools/boards.ts`),
  the PA's `ticket_*` builtins, and the peer-delegated subset a shared agent
  gets in a project channel (`PEER_PROJECT_TOOL_IDS`, `run-setup.ts:61`).
- **T6 — the dialog is an explicit-save form over a `useDraft`**, two columns
  from `md` up, `Documents` a bordered box under the grid (a nesting the design
  system forbids), and it has no read-only or phone branch. `?task=` is the
  navigation contract and stays.

## 1. Decisions at a glance

| Question | Decision | Rejected | Why |
|---|---|---|---|
| What a label is | First-class `TaskLabel`, **project-scoped**, hex colour, optional `(sourceId, externalId)` | Keep labels as the *Labels* multi_select field | A native project must label without first creating a field; agents need a nameable concept; providers give colours the closed `tone` set cannot hold. Project scope matches custom fields and the one-source-per-project shape. |
| The wall of pills | One `TokenInput` primitive (pills inside a growing field, typeahead popover) used by the label field **and** by every `multi_select` custom field | A label-only control | Rule zero §4 — one control parameterised, and the same complaint applies to any multi_select. |
| Label colour vs the token rule | Colour is **data** on the row, rendered through one `LabelPill` that mixes the hex into the surface tokens | Palette-only `tone` | Same carve-out the organisation theme took: colour that is data, not stylesheet. Contrast is guaranteed by construction (text is always `--tx`). |
| Labels on a mirrored ticket | Labels the source owns (`label.sourceId = source`) follow §5.7 write-mode rules; Nessie-only labels are local and survive every sync | All-or-nothing | "Edit every Nessie-only field" is the existing rule for mirrored tickets; sync replaces only the subset it knows. |
| Comments | Flat `TaskComment` thread, Markdown body, author is a person **or** an agent **or** an external provider user, author-only edit/delete, soft delete | Threaded replies; admin delete | Flat is what three of four providers show first; "a message belongs to its author" is the settled rule (`softDeleteMessage`). |
| Files | `Attachment.taskId` / `Attachment.taskCommentId` (app-enforced, like `messageId`), **one upload door** (`POST /api/uploads`) and link doors on the task, comment and create routes; a `taskId` arm in `canAccessAttachment` | A new multipart route per surface; a `TaskAttachment` join | The message composer already does upload-then-link with progress and the secret scan; a second byte path is the fork the file-storage standard forbids. |
| Inline images | Markdown `![alt](/api/attachments/<id>)`; an inline image **is** a task attachment; renderer and editor resolve that path through the authed blob hook | `nessie://` scheme; data URIs; unauthenticated image route | One URL form the existing `attachmentPath()` already produces, no new auth surface, and the file stays governed by the task's ACL. |
| Editor | Tiptap StarterKit + `@tiptap/extension-image` + the official `@tiptap/markdown`, every `@tiptap/*` pinned to one 3.31.x; Markdown is the stored form, HTML never leaves the browser | `tiptap-markdown` (community), a textarea with preview, storing HTML | Peer-exact official packages already in the tree; one serializer both ways; `Task.detail` stays Markdown for agents, search and import. |
| Description toggle | Read view (rendered Markdown, *Edit* button) ↔ editor (*Done*); create mode opens in the editor | Always-on editor | Ondrej asked for a toggle; a read view is what people do most and what images look right in. |
| Documents placement | Left column, directly under the description; then Attachments; then Comments | Under the grid | Exactly the request, and it removes the nested bordered box. |
| Import audience (§4.3) | Linear, GitHub, Trello comments share their issue's audience → imported under the task's project; a Jira comment carrying a `visibility` restriction is **skipped** | Import everything; import nothing | The §5.3 objection is real for exactly one provider feature, and that one is detectable. |
| Import authors | Through `BoardSourceIdentityLink` (reused, email-matched like assignees); unmapped → `externalAuthor*` provider display data, never a `User` | Creating users | UOA owns identity; provider display data about the provider's own user is the `remoteAssigneeDisplay` precedent. |
| Fetching provider files | Optional `fetchAsset` adapter method through a streaming `sourceFetchStream` with a per-adapter asset-host allowlist and a 25 MiB cap; a fetch that fails leaves the external link in place, retried thrice, then `failed` | Hot-linking provider URLs | Provider files need the provider credential; a hot link in a Nessie ticket is a dead image for everyone but the connection owner. |
| Realtime | Two new content-free event **names** in the unchanged envelope: `task.activity { taskId, projectId }` and the already-defined `task.updated` published from the task routes | A payload with the comment | Content-free events are the `board.updated` precedent; a new name inside the same envelope is inert to old replicas and old clients. |
| Agent surfaces | MCP `nessie_task_comment_*`, `nessie_task_attachment_*`, `nessie_label_*`, and `labelIds` on task create/update; PA/peer `ticket_comment_*`, `ticket_labels_read`, `ticket_label_create`, `ticket_attachment_*`; both over the same `@nessie/team-admin` functions | MCP only | "Reflected in the MCP" is a test of reach: the peer agent in a project channel is the one Ondrej talks to about a ticket. |
| Label management doorway | Project → Settings → **Labels** (rename inline, recolour, delete with count); reached from the token dropdown's last row *Manage labels…* and the settings strip | Managing in the dropdown | Rename/recolour/delete need a row with a count; a dropdown is for choosing. |

## 2. Open questions for Ondrej

Only genuinely his calls; everything else is decided above.

1. **Label scope beyond a project.** This design scopes labels to the project
   (like custom fields). Linear workspace-level labels therefore import once
   per project that syncs a team using them. If the organisation should share
   one label set, that is a later migration (`organizationId` scope with a
   project override), not a change to this design.
2. **Attachments going back to Linear.** §4.6 writes comments and labels back
   in `read_write`; files do not go up in v1 (Linear's `attachmentCreate`
   needs a URL Linear can fetch, and ours are private). If that matters
   sooner than the follow-up, say so and §4.6 gets a signed-URL door.
3. **Who deletes a file on a ticket.** This design lets the uploader *or any
   project member* remove an attachment (a ticket is joint work under the
   equal-rights rule), while a comment stays author-only. If files should be
   author-only too, it is one predicate in §2.3.

## 7. As built

The code wins over this plan; these are the deltas that matter to a reader.

- **Components moved for the layer lint:** `TokenInput` and
  `AuthedAttachmentImage` live in `admin/src/components/shared/`; the pure key
  table stays in `primitives/token-input-keys.ts`. The authed image uses its
  own status-aware `useAuthedImage` (same blob cache) so a 404 can show
  *Image removed*.
- **Comment paging is oldest-first**; later pages are newer, so the control
  is *Show more comments* below the list.
- **One comment write-back builder**, `createTaskCommentWriteBackFromSource`,
  used by the REST routes and the worker's agent tools alike.
- **Path-aware inline scan:** adapters may declare `isAssetUrl`; GitHub
  (`github.com/user-attachments/…`) and Trello (attachment downloads) do,
  because their upload hosts also serve ordinary pages.
- **MCP attachments** are stored, then linked through `linkTaskAttachments`
  (the route's door); `nessie_task_attachment_get` returns metadata only for
  large or binary files, because an agent credential cannot download outside
  `/mcp`. MCP comments are authored by the person who approved the
  credential; a shared agent in a project channel authors as itself.
- **Jira:** Service Management internal notes are restricted like
  `visibility` comments and never imported; comment bodies convert ADF to
  Markdown, descriptions stay on the old converter so fingerprints do not
  move. Every adapter still emits `fields.labels` beside native labels for the
  same reason.
- **Not verified against live providers:** Linear's uploads host with the
  authorization header, Linear `Comment`/`IssueLabel` webhook field names,
  GitHub's upload redirect, Trello's download header, Jira `redirect=false`
  and `comment/list`. The §6.4 live check is still owed.
- **Open questions (§2)** remain Ondrej's: organisation-wide labels, files
  back to Linear, author-only attachment removal (built: uploader or any
  project member).
