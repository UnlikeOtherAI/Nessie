# Document triggers — an edit to a project's documents wakes an agent to review it

Authoritative standard. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.** The design is
[docs/plans/2026-09-23-ticket-driven-agents/triggers.md](../plans/2026-09-23-ticket-driven-agents/triggers.md)
→ "`document_changed`"; where that plan and the code differ, the code and this
file win, and each difference is listed under [Deviations](#deviations-from-the-plan).
Ticket work — the record, its thread, the `ticket.work` run — is
[ticket-work.md](ticket-work.md); this file says only how a document change
reaches it.

A person saves one of a project's documents. After a quiet window the agent a
`document_changed` trigger names is woken to review the change — in the
ticket's work thread when the document belongs to a ticket the same agent is
working, otherwise in the document's own review thread. The wake carries **no
document text**: the agent reads the change itself, through the same gates as
any read.

## What is shipped (T2)

Everything below is enforced in code: the typed configuration and its
server-side resolution, the version hook on every canonical writer, the quiet
window, the delivery and its routing, `kb_page_diff`, access lost as a health
stop, the Finder read, and the admin surfaces (the Triggers editor's document
fields, "Tell an agent when this changes…" in the Finder and project docs, and
the row badge).

## A document trigger's configuration is resolved on the server

- **The config is the `document_changed` arm of the typed union**
  (`DocumentChangedTriggerConfigSchema`, `packages/schemas/src/trigger-configs.ts`):
  `targetChannelId` beside a config of `spaceId?`, `folderPageId?`,
  `pageIds?` (1–50), `labels?` (1–20, any one matches, without case), `kinds`
  (`document` and/or `file`, default both — never `spreadsheet`), `fireOn`
  (`save` | `publish`, default `save`), `quietSeconds` (10–3600, default 180),
  `includeAgentEdits` (default false) and `instructions { general }`
  (required). It is strict, and every field is described, so the agent tools'
  enum and the Designer's catalogue are generated from it
  ([ticket-work.md](ticket-work.md) → "Nothing is half-exposed"). Taking
  `document_changed` off `UNRELEASED_TRIGGER_TYPES` released it; the list is
  empty now.
- **Resolution** (`resolveDocumentChangedTrigger`,
  `packages/team-admin/src/trigger-document-config.ts`) derives the project
  from the target channel, which must be live, ordinary and **public** with
  the agent bound — the check ticket triggers use, shared as
  `resolveTriggerTargetChannel` (`trigger-target-channel.ts`). The space is
  always stored by id: the one named, else the space of the folder or pages
  named, else the project's Documents space (`metadata.projectDocuments`); a
  space of another project is refused. `folderPageId` must be a folder of that
  space, each of `pageIds` a page of it of a watched kind. The stored config
  is `DocumentChangedStoredConfigSchema`'s shape (`folderPageId`, `pageIds`,
  `labels` null when absent), and the trigger's `scope_project_id` is the
  resolved project, which is how a save finds it; `scope_board_id` and
  `target_thread_id` stay null.
- **Three reads decide whether the agent may watch the space**, each refused
  on `spaceId`:
  - **the whole channel may read it** (`documentSpaceAudienceRefusal`): a
    project- or organisation-wide space, never private, channel- or team-only,
    restricted, private to an agent, or an agent's own home — every change is
    reviewed in that channel. "The whole channel" is read as ticket triggers
    read it: a public channel of the project is the project's audience, which
    is also how the disclosure model treats a reply there (a project channel
    implies its project and organisation scopes, `subtractImpliedScopes`). A
    team-only space is narrower than its project, so it is refused;
  - **the agent may read it**, with its own reach (`canReadSpace` over the
    agent's `SpaceViewer`): a document review runs with no effective user;
  - **the person setting it up may read it**, asked of their live entitlement
    (`resolveLiveEntitlements` with the request's UOA identity): nobody arms
    an agent on documents they could not open. A create with no person behind
    it is refused on `config` (`DOCUMENT_TRIGGER_NEEDS_A_PERSON`).
- **Every page, folder and space the config names is read by the person and
  by the agent before anything about it is said**
  (`loadDocumentTriggerReaders`, `trigger-document-readers.ts`), the person
  first. One the person cannot read is refused exactly as one that does not
  exist — "no such document", "no such folder", "no such document space in
  this organisation" — so a refusal never confirms that a page or space the
  person may not open exists. A page the agent may not read (restricted, or
  private to another agent) or in a space the agent cannot reach is refused
  with what to change. **No refusal quotes a page title or a space name at
  all**, even one the person could read: it names the field, the project or
  channel, and the rule.
- **The creator is not re-checked when the trigger fires**, by the plan: a
  trigger keeps running after its author loses access to the space. What a
  review may read is decided at every fire by the **agent's** reach and the
  channel's audience (see "Access lost pauses the trigger"), never by who set
  it up; a person is asked again only when the config is edited or the
  trigger is resumed.
- **Refusals are field-level** (`TriggerConfigRefusalError`, the routes'
  400 `TRIGGER_CONFIG_REFUSED`), as for ticket triggers.
- **An edit names only what it changes** (`documentChangedConfigAsInput`,
  `mergeDocumentConfigPatch`): a key replaces, `instructions` merges one level
  deep, `null` clears a narrowing, and the whole is resolved again, with the
  editor's read in the author's place. **A config change with no person
  behind it is refused** on `config`; a rename, a description or an
  enable/disable is not a config change. **A resume resolves the stored
  config as a create would** (`documentTriggerResumeRefusal`), with the
  **resumer's** read in the author's place — a resume with no person behind
  it is refused; a trigger that stopped on a health failure is resumable
  once repaired (`resumeAgentTrigger` resolves it instead of asking for a
  fixed thread it never had — the same fix now holds ticket triggers).
- **No hand fire.** `POST /api/triggers/:id/fire` answers 409
  `DOCUMENT_TRIGGER_NOT_FIREABLE`: a review starts from a saved version.

## Every saved version is announced, inside the save

- **`onVersionCreated`** (`KnowledgeVersionCreatedEvent`,
  `packages/knowledge/src/version-events.ts`) is the one "a version exists
  now" signal: `createPage`, `updatePage`, `addFileVersion` and
  `restoreVersion` (`native-version-writer.ts`) each call
  `announceVersionCreated` after the version row and its disclosure, in the
  save's transaction, so a failed enqueue rolls the save back — and **after
  the page's labels are written** (`createPage` writes them before the
  version, `updatePage` announces last), so a label filter sees the labels
  the save leaves: a page created with a watched label, or given one, opens
  its window. It carries the
  page's own project, space and kind, and the version's number, author and
  origin. A `legacy_migration` version is never announced; a transfer copy
  (`transfer/copy.ts`) and the agent-core migration write their versions
  without the writer and announce nothing — neither is anybody editing a
  document. A folder has no versions. `onVersionChunksReplaced` is unchanged:
  it fires only when chunk rows were rewritten, which is not the same thing.
- **The consumer is `enqueueDocumentTriggerDispatch`**
  (`packages/team-admin/src/document-trigger-enqueue.ts`), wired as
  `documentTriggerOnVersionCreated` (fireOn `save`) and
  `documentTriggerOnPagePublished` (fireOn `publish`, reusing
  `onPagePublished`). It reads the enabled, active `document_changed`
  triggers by `scope_project_id` — a save no trigger watches costs one indexed
  read — and matches each on its space, kind, folder subtree, pages and labels
  (`documentTriggerWatchesPage`). A spreadsheet is never watched. Every save
  is enqueued, the agent's own included: whose saves wake the agent is the
  dispatcher's decision, and its own must still move the marker.
- **Wired by every process that writes documents:** the API's knowledge and
  transfer routes share one set of hooks (`apiKnowledgeProviderOptions`,
  `api/src/routes/knowledge-provider-options.ts`), the publish approval
  (`approval-effects.ts`), the worker's knowledge tools
  (`createWorkerKnowledgeProvider`, both `onVersionCreated` and
  `onPagePublished`, so an agent's publish opens a publish window as a
  person's does) and the DeepWater report import. The
  spreadsheet provider, agent-core admission and task-set finalisation wire
  none: spreadsheets are excluded, and the other two write agent core and run
  output, not project documents.

## One quiet window, one review

- **The window is the queue's own delay.** The first save of a window
  enqueues `trigger.document.dispatch` (`TriggerDocumentDispatchJobPayloadSchema`:
  organisation, page, trigger — no version) with `delayMs = quietSeconds`
  and idempotency key `doc:<triggerId>:<pageId>:pending`
  (`documentTriggerPendingKey`); every later save in the window hits that key
  and adds nothing — but **row-locks the job holding it until the save
  commits** (`enqueueQueueJob` `onConflict: 'lock'`, an `ON CONFLICT DO
  UPDATE` that changes nothing). `queue_jobs` keys are unique forever, so the
  handler's **first statement releases its key** (sets it null, in
  `releaseWindow`, `document-trigger-settle.ts`); that update waits for every
  save that joined the window, so the read that follows sees them all, and a
  save that starts after it opens the next window. **After the window is
  decided, a version newer than the one it read opens the next window**
  (`openNextWindowIfMoved`) — a save that committed meanwhile without a
  window of its own is never left unreviewed; its key collapses into any
  window a save already opened.
- **When the job fires** (`dispatchDocumentChange`,
  `worker/src/control/document-trigger-dispatch.ts`) it reads the page's
  newest version (`fireOn: save`) or its published one (`publish`). The
  **marker** is the highest `toVersionNumber` among this trigger's deliveries
  for the page that moved it — delivered ones, and `agent_edits_only` skips
  (`loadMarker`); a skip for lost access, a narrower page, the wake limit, a
  page out of scope or a stopped ticket leaves the change owed, so the next
  review's diff still covers it.
  With no marker yet, the review starts from the page as it stood when the
  trigger was set up (`loadBaseline`), or from nothing for a page created
  since. Nothing after the marker: nothing happens.
- **Exactly one delivery per change**, deduped on
  `doc:<triggerId>:<pageId>:<toVersionId>` (`documentTriggerDeliveryKey`) on
  the existing `@@unique([triggerId, dedupeKey])`, with `source: document`
  and a `DocumentTriggerDeliveryPayloadSchema` payload: page, space, project,
  ticket, kind, fireOn, from and to version ids and numbers, how many
  versions were coalesced, the kinds of author that woke the agent, the body
  size, the outcome and its workId or threadId. **Metadata only**: no title,
  no text — the delivery log is read on the Triggers page, whose readers need
  not be able to read the document. A throw leaves a failed, retryable row;
  the delivery-retry poller decides the page again
  (`reattemptDocumentTriggerDelivery`), reusing the row only while the change
  is the same one.
- **Skips, each a delivery with its reason** (`DocumentTriggerSkipReasonSchema`,
  `DOCUMENT_TRIGGER_SKIP_SENTENCES`): `agent_edits_only`, `out_of_scope`
  (moved out of the folder, label removed, archived), `page_gone`,
  `access_lost`, `page_not_readable`, `wake_limit`, `config_invalid`,
  `no_longer_applies`.

## The agent's own edits never wake it

Versions after the marker are counted by who saved them (`countVersions`,
`wakingVersions` in `document-trigger-loop-guard.ts`). A review can edit the
document it reviews, so every agent save that could have come from a review
is left out, whatever project it was in:

- the trigger's own agent's, always — an agent reviewing a document and
  editing it cannot loop;
- any other agent's, unless the trigger sets `includeAgentEdits`;
- even then, never an agent with an enabled `document_changed` trigger
  **anywhere in the organisation** — two reviewers of different projects that
  both include agent edits would otherwise wake each other forever;
- and never a version an agent saved while a run a document trigger started
  was live for it (the run's trigger, or its delivery's, is a
  `document_changed` one; created at or before the save, finished at or
  after it, or not yet) — even after that trigger was switched off.

All of it is structural — who saved the version, which triggers exist, which
runs were live — and nothing reads what a version says. A window of nothing
but uncounted versions is skipped `agent_edits_only` and moves the marker
past them, so the next person's edit is diffed from the agent's last version
rather than re-showing its own changes.

**A page wakes its agent at most `DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY` (20)
times in any 24 hours** (`wakesInLastDay`, counting this trigger's delivered
deliveries for the page). A review thread has no work record and so no wake
limit of its own; this is its ceiling, whatever loop or burst of saves might
otherwise wake it. Past it the window is skipped `wake_limit` and the marker
does not move: the first window after that reviews the change with
everything since.

## Where a change lands

In this order (`routeDocumentChange`, `document-trigger-route.ts`), inside the
delivery's transaction:

1. **The page's ticket's live work for this trigger's agent.** A ticket
   document (`KnowledgePage.taskId`) whose ticket has a live work record of
   **the same agent** wakes that record as a follow with reason
   `document_changed`, in its work thread, through the ticket work seam
   (`wakeTicketWork` with a precomputed event) — so the wake counts against
   `wakesPerTicket`, folds into a pending kickoff, and writes the thread's
   "Woken:" row like any follow. The ticket trigger's own rules hold: it must
   follow `document`, and a person who can edit the board must have saved
   part of the change — an agent's or a non-editor's edit never steers ticket
   work. Only that agent's record is woken, however many ticket triggers cover
   the board. The event carries the document trigger's own instructions.
   To the T3 rules ([ticket-work-reminders.md](ticket-work-reminders.md)) it
   is a wake like any follow — it takes the thread's run slot before it
   writes the record, counts, and restarts the quiet wake's wait
   (`lastWakeAt`) — but **it answers no open question**: only a comment, a
   thread message or a move does, so an agent waiting on a person keeps
   waiting through a spec edit.
   A ticket's state block promises document edits only while such a trigger
   exists for its agent (`documentsWatched`), worded as "one of its
   documents that your document trigger watches", since it may cover only some.
2. **Otherwise the page's own review thread**: one per (trigger, page) in the
   target channel (`ensureDocumentReviewThread`,
   `worker/src/control/document-trigger-run.ts`), a conversation with the
   trigger's agent opened by nobody, with metadata `{ pageId, triggerId }`
   (`DocumentTriggerThreadMetadataSchema`) — never the channel's General
   thread — titled `Review: <title>`, or by the page's id where the title may
   not be said. The run acts as the agent with no effective user and
   `interactive: false`, purpose `document_changed`, like every event
   trigger. Each wake writes a compact `document_woken` row
   (`TicketWorkThreadEventSchema`), which the thread feed shows as "Woken:".
   The agent's conversation list folds these threads under **Documents**, as
   it folds work threads under Tickets: the conversation record carries
   `document: { pageId }` from the thread's metadata
   (`documentReviewThreadRefOf`, `agent-conversation-tickets.ts`).
   A ticket's document lands here when that ticket's work is not live for the
   agent, does not follow documents, or was steered by nobody who may, and
   the kickoff names the ticket and says which. A ticket work wake the seam
   refuses (a limit, work that ended a moment ago, or — under standing
   machine access — work whose machine is offline, which the kickoff says is
   waiting for it rather than ended) is reviewed here too, rather than lost.
   A wake the seam takes is a `ticket.work` wake like any other: its run is
   bound through the ticket's standing policy afresh
   ([ticket-work-machine-access.md](ticket-work-machine-access.md)).

## What a wake says

- **Metadata only** (`describeDocumentChange`, `renderDocumentReviewKickoff`,
  `document-trigger-kickoff.ts`): who saved it by kind ("a person", "2 people
  and another agent"), which versions, how many, how large, and the exact call
  that reads the change — `kb_page_diff(pageId, fromVersionId, toVersionId)`,
  or `kb_page_read(pageId, versionId)` for a page with nothing to diff
  against. Never a word of the document.
- **The page is named by its title only when every reader of the target
  channel may read it** (`pageNameableInChannel`): the space already is (it
  is checked on every fire), the page is project- or organisation-wide, not
  restricted or private to an agent, and the version carries no disclosure
  basis of its own. Otherwise it is named by id, and the review thread too.
- A change any part of which a person who cannot edit the board, or another
  agent, saved is framed as third-party content: information, never an
  instruction, never forwarded to a coding agent as one.

## Reading the change: `kb_page_diff`

`kb_page_diff(pageId, fromVersionId, toVersionId)`
(`worker/src/run/pa-tools/knowledge-diff.ts`, a safe builtin enabled like
`kb_page_read`) passes exactly `kb_page_read`'s gates — now one module,
`knowledge-page-gate.ts` — for the page **and for each version**: the space
readable by the caller, no restricted page and no page private to another
agent for an agent, each version this page's and passing its own disclosure
basis. Both versions are recorded in the run's consumed-source sink before a
word of either is read, because a diff discloses both sides. The answer is
unified hunks from the shared line diff (`computeLineDiff`,
`renderLineDiffHunks`, `packages/schemas/src/line-diff.ts`, which the admin's
review panel and a ticket-work description wake use too), cut at 12 000
characters with a note naming the `kb_page_read` call that reads the rest.
The diff stays the lines that changed however long the document: the
unchanged head and tail are trimmed first, and a middle too large for the
LCS table is diffed with Myers (up to 2 000 differing lines, past which that
middle alone reads as removed and re-added). A line longer than a quarter of
the bound is clipped around where it differs from the line it replaced, with
`[… n characters]` markers, rather than dropped with everything after it.

## Access lost pauses the trigger, loudly

At every fire the dispatcher asks again whether the agent can read the space
it watches, and whether the space is still as wide as the channel
(`agentPageAccess`, `documentSpaceAudienceRefusal`). If not, the change is
skipped `access_lost` **and the trigger is switched off with health reason
`document_trigger_access_lost`** (`recordTriggerHealthFailure`: status
`error`, one health alert), never skipped in silence; its owner fixes access
and resumes it. **One page narrower than its space** — restricted, or
private to another agent — is that page's business, not the trigger's: its
change is skipped `page_not_readable` and the trigger keeps watching the
rest. A config that no longer parses stops it with
`document_trigger_config_invalid`. The document trigger's **own target
channel is checked on both routes** (`assertTargetChannel`, first in
`routeDocumentChange`): a channel that lost the agent or went non-public
throws the classified `agent_channel_access_lost`, as a ticket trigger's
does, even when the change would have gone to a ticket's work thread in
another channel.

## What a person sees

- **The Finder read** `GET /api/knowledge-base/spaces/:spaceId/document-triggers?pageIds=…`
  (`api/src/routes/knowledge-document-triggers.ts`, `loadDocumentReviews`),
  behind the space's own read rule and each page's disclosure, never the
  owner-only Triggers routes: for each listed page the viewer may read, the
  newest delivered review to an agent the viewer may see
  (`DocumentReviewRecordSchema`: agent, version, `state`, `sentAt`), the
  thread only when the viewer may open it; and `viewerCanCreateTriggers`, the
  Triggers routes' own owner gate.
- **The Triggers editor** offers "Document change" for an agent target only
  (`TriggerTypePicker agentTarget`). Its fields (`DocumentTriggerFields`,
  `document-trigger-form.ts`) offer only public project channels and say why,
  the channel's project's spaces — a space no public channel may watch shown
  but disabled (`spaceNarrowerThanChannel`, the server's audience rule as far
  as a space record shows it) — its folders and pages by path, labels, kinds,
  save or publish, the agent-edits opt-in and its loop guarantee, the quiet
  window in words ("5 min after the first save"), and the instructions. It
  posts the typed config by id (an edit sends `null` for a narrowing it
  removed), and a refusal lands on the field its path names
  (`groupDocumentRefusals`, on the shared `groupTriggerRefusals`). A document
  trigger's page names its space, folder and labels
  (`document-trigger-facts.ts`) and says what each delivery decided
  (`documentDeliveryLine`: the skip sentence, "reviewed in the document's
  thread", "woke the ticket's work"). There is no "Run now"
  (`canRunTriggerNow`), and its health reasons read as sentences
  (`TRIGGER_HEALTH_COPY`).
- **The Finder, and so a project's Docs tab**: "Tell an agent when this
  changes…" on a folder, document or file — never a spreadsheet, never a
  virtual row, never in a space no public channel may watch, and only when
  the Finder read says `viewerCanCreateTriggers` — opens the Triggers editor
  on a document trigger for that folder or page, type and target kind fixed,
  on a draft of its own (`FinderDocumentTrigger.tsx`, the pattern
  `BoardStartWorkDialog` set). A row whose change was sent to an agent
  carries *"Sent to CTO for review · v5"*, and *"Reviewed by CTO · v5"* once
  a run that took the change in completed — the run the delivery started, or
  one in the same thread started after it (`DocumentReviewRecord.state`)
  (`DocumentReviewBadge`, `loadDocumentReviews`), from one read per listed
  folder (`useFolderDocumentReviews`), never per row. The badge is the newest
  delivery **to an agent the viewer may see**: a newer one to an agent hidden
  from the viewer is passed over rather than taking the badge away, and never
  named. The row is itself a button, so the badge is not a nested link: a
  click on it opens the review thread, and the row's menu offers "Open review
  thread" for the keyboard; without a thread the viewer may open, the badge
  is text. In the list view the badges sit beside the title, in the name
  cell (`FinderRow`), not in the 16px trailing lane.

## Deviations from the plan

- **Refusals name nothing.** The plan asks only that the author may read
  the space; here every named page, folder and space is read by the person
  and the agent before anything about it is said, one the person cannot read
  is "no such …", and no refusal quotes a title or a space name.
- **Lost access pauses only for the space.** A single page narrower than its
  space is skipped `page_not_readable`; pausing the trigger for it would stop
  every other page's review over one restricted document.
- **The loop guard is organisation-wide and run-aware, with a daily
  ceiling.** The plan's "the agent's own edits never wake it" is kept, and
  extended: no agent with an enabled document trigger anywhere in the
  organisation counts, no save made during a document-trigger run counts,
  and a page wakes its agent at most `DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY`
  times a day.
- **A window's saves hold its job, and a late save opens the next window.**
  The plan's "every later save hits the key" is kept; the lock and the
  re-read after deciding are what make "the job sees every save of its
  window" true under concurrent commits.
- **The badge says "Sent to CTO for review · v5" until the review ran**,
  and the plan's *"Reviewed by CTO · v5"* only after.
- **Only `KnowledgePage.taskId` links a page to a ticket.** The plan's "or a
  live work record that links the page" has no counterpart: a work record
  names no pages. Route 1 reads the page's `taskId`.
- **Route 1 keeps the ticket trigger's follow rules**: the ticket trigger must
  follow `document`, and a board editor must have saved part of the change.
  Otherwise the change goes to the page's own thread, with the reason, rather
  than being dropped.
- **The space is always resolved and stored**, `spaceId?` in the input only:
  the three reads need a concrete space.
- **The first review of a page diffs from the page as it stood when the
  trigger was set up** (`loadBaseline`), not from nothing.
- **The window key is released by the handler**: `queue_jobs` idempotency keys
  are unique forever, so `doc:<triggerId>:<pageId>:pending` would otherwise
  admit one window per page ever.
- **A document review is `interactive: false` with purpose `document_changed`**
  and writes a `document_woken` row; its run carries the document trigger's
  `triggerId`. A route-1 wake's run carries the **ticket** trigger's id (its
  limits and instructions are the ticket's) and the document trigger's
  delivery id.

## Tests that hold these rules

- `packages/schemas/src/__tests__/document-triggers.test.ts`,
  `trigger-configs.test.ts` and `line-diff.test.ts`: the arm's defaults and
  refusals, the scope matcher, the keys, a metadata-only payload, hunks and
  their bound, a one-line edit of a 2 100-line document as one line,
  scattered edits past the LCS table still minimal (Myers), and a 30 000
  character line clipped around its change.
- `packages/knowledge/test/version-events-db.test.ts`: every writer announces
  its version; a folder, a metadata-only edit, a `legacy_migration` version
  and a transfer copy announce none.
- `packages/team-admin/test/trigger-document-config-db.test.ts`: resolution
  (Documents space, folder-implied space, one-key edit), every field-level
  refusal (a private channel, another project's space, a private or
  restricted space, a non-folder, a foreign page, a kind mismatch, missing
  instructions, a thread or schedule, an author who cannot read the space, no
  author), a page, folder and space of another person's private space refused
  as "no such …" with no title or name in any refusal, a config edit with no
  person refused, the resume refusal (no resumer, a resumer who cannot read
  the space), and the quiet window opened once per window,
  never by a paused trigger, a publish trigger on save, or a page outside the
  folder. `trigger-type-availability.test.ts`: every type released.
- `worker/test/db/document-trigger.test.ts`: coalescing into one review in the
  page's own thread with no document text, the key released for the next
  window and its diff from the marker, the agent's own and other agents'
  saves (and, with `includeAgentEdits`, another agent's, never a fellow
  reviewer's), a ticket's document routed to its live work, a ticket document with
  no live work reviewed in its own thread naming the ticket, a board with two
  ticket triggers waking only the same agent's record, and access lost
  pausing the trigger with a health reason and one alert.
  `worker/test/db/document-trigger-guards.test.ts`: a save that joined the
  window but commits after the job started is what the job reads (the job
  waits for it), a save that lands while a window is decided opens the next,
  a label-filtered trigger seeing a page created with its label and one given
  it, an agent's publish opening a publish window through the worker's
  provider, a restricted page and one private to another agent skipped
  `page_not_readable` without pausing the trigger, a reviewer of another
  project and a save made during a document-trigger run never counting, the
  daily wake ceiling with the change still owed, and route 1 pausing the
  trigger whose own channel the agent left, and a document wake of ticket
  work leaving its open question open.
  `worker/test/db/document-trigger-naming.test.ts`: a version from a narrower
  basis and a page private to the agent itself reviewed by id — thread
  title (renamed when a later version narrows it), kickoff and thread row.
  `worker/test/db/knowledge-diff.test.ts`: hunks, both versions recorded, the
  gates for the page and each version, the 12 000-character cut, and one
  edited long paragraph of a 2 100-line document shown around its change.
- `api/test/knowledge-document-triggers-routes.test.ts`: the Finder read's
  newest review per readable page by an agent the viewer may see (a newer one
  by a hidden agent passed over), "sent" until its run completed and
  "reviewed" after, a thread linked only for its readers, the owner-only
  doorway, a space the viewer cannot read refused.
- `admin/test/document-trigger-form.test.ts`: the form posts exactly what
  `DocumentChangedTriggerConfigSchema` parses (an edit merged as the server
  merges it), a refusal lands on its field, only public project channels and
  channel-wide spaces are offered, the delivery lines.
  `admin/test/document-review-badge.test.tsx`: the badge with and without a
  thread, "Sent to CTO for review" before the review ran, and the
  `document_woken` "Woken:" row.
  `admin/test/finder-menu.test.ts`: the doorway only for
  `viewerCanCreateTriggers`, never on a spreadsheet or a virtual row.
  `admin/test/trigger-type-unreleased.test.tsx`: both agent-only types offered
  for an agent only, never run by hand, edited as typed configs.
- `pnpm --filter @nessie/admin test:e2e:agent-triggers` (see `CLAUDE.md`):
  the document form, a refusal on the space field, the typed create, the
  trigger's page, and in a project's Docs tab the badges ("Reviewed by …"
  and "Sent to … for review"), the menu and the prefilled doorway — at 1280
  and 390 px. `pnpm --filter @nessie/admin test:e2e:agent-conversations`:
  a review thread folded under Documents at every width, and open by itself
  when it is the thread on screen.
