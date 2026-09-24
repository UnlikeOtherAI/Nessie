# Disclosure boundaries — what an agent read decides who may read its answer

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

Task-set processors and receiver handoffs retain the same source chain. See
[task-set artifacts](task-set-artifacts.md) for pinned file reads, completion
claims, machine permissions and the explicit mailbox provenance discriminator.

- **A read that enters a run's context feeds the disclosure sink, in the same
  change.** An agent reaches material its audience cannot, and what stops it
  laundering that into a shared room is provenance: `ConsumedSourceSink`
  (`worker/src/run/execute/disclosure-basis.ts`) collects the scoped sources a run
  consumed, `computeReplyBasis` subtracts what the destination already implies,
  and the remainder is stamped on the message and the run by the one write
  chokepoint (`agent-message.ts`). **An empty basis means unrestricted**, so a
  read path that forgets to feed the sink does not fail loudly — it publishes to
  everyone. That is the whole defect class, and it is why the obligation sits on
  the *read*, not on the reply. Adding a tool that puts content in the window and
  not adding its scope is the same defect as skipping the `FileService`.
  Corollaries, each learned from a real gap: resolve a source's scope with the
  shared `scopeForVisibility` rather than a second mapping beside your reader,
  since a thought's `(audience_type, audience_id)` and a knowledge space's
  `visibility` + chain are one fact in two shapes; record a channel scope only
  when the channel is **not public**, because viewer channel scopes come from
  `ChannelMember` rows alone and stamping a public channel withholds the reply
  from people entitled to read the source (host program output, whose source
  is not the room's history, is the one exception — see "Detail"); and make
  search **fail closed**
  (exclude anything carrying a basis) rather than withhold, because a snippet
  list has nowhere to render a placeholder. On the read side every path asks the
  one predicate — list, single message, and the durable thought log alike, since
  reasoning inherits the provenance of what the reply was built from. The live
  SSE lanes cannot filter per viewer, so `runReplyIsRestricted` cuts them the
  moment a run consumes a source beyond its destination; that predicate is
  monotone by construction, which is what makes it safe to call per delta.
  Separately, all content-bearing realtime activity for a non-public channel
  uses its channel scope alone: a destination's own channel basis must never
  reopen organisation or agent broadcast lanes. Containment
  (`constrainScopesToDestination`) is a floor under all of
  this, but it constrains **memory recall only** — never treat it as "nothing
  crosses". Details: `CLAUDE.md` → "Disclosure boundaries"; spec and build status:
  `docs/plans/2026-08-11-disclosure-boundaries-build.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Disclosure boundaries — what an agent read decides who may read its answer".


Provenance, not redaction: every read that enters a run's context feeds the
`ConsumedSourceSink` in the same change. The rule and its corollaries (empty
basis fails open, shared `scopeForVisibility`, channel scopes only for
non-public channels, search fails closed, every read path asks one predicate,
live lanes cut by `runReplyIsRestricted`, containment = memory recall only): stated above.
Facts not restated there:

- Thread reach is the channel's read audience: only public standard non-system
  channels are browsable without joining. DMs and system rooms require actual
  channel membership even if stored as public; deleted channels are unreadable.
  `buildAccessibleChannelWhere` supplies this rule to thread, conversation and
  agent-history readers, and the request visibility helper applies the same rule.
- **System messages are internal run instructions, never conversation history.**
  Thread feeds, search (human and agent), agent history and direct message reads
  exclude `role: system` even when the row has no disclosure basis. Hidden roots
  are not followable. The executing run reads its exact trigger through the run
  admission path, which separately checks and inherits its provenance; hiding a
  row is not a substitute for stamping its canonical basis and source authors.
- The remainder after `computeReplyBasis` is stamped as `MessageBasisScope` +
  `RunBasisScope` in the same transaction as the message; `agent-message.ts`
  opens that transaction itself rather than trusting callers. A server-authored
  message that relays gathered content (a DeepWater research card, result or
  notice) is stamped only inside its own create:
  `SystemAuthoredMessageInput.basisScopes` / `disclosureSources` go through the
  shared `insertMessageBasis` / `insertMessageDisclosureSources` helpers in the
  row's transaction, with the remainder computed against the destination
  thread's live chain and bound agents. A notice about a person's DeepWater
  brief that was never launched is not posted in the room at all, withheld or
  otherwise: it goes to the requester's own Personal Assistant conversation,
  stamped against that thread, because a placeholder in the room would still
  say that a private brief exists ([deepwater.md](deepwater.md) → "Delivery").
- The run ledger is monotone and is persisted before any run plan, tool
  summary/preview, or crash checkpoint records derived content. A run that has
  not replied yet is therefore still protected at every metadata read path.
- Basis vocabulary is `user | channel | team | project | organization | agent`.
  `agent:<id>` means exactly the people who pass the shared live agent-visibility
  predicate. A destination implies agents bound to its channel; those ids are
  loaded once into the run context so `runReplyIsRestricted` stays synchronous
  on every streamed delta. Tool-posted messages resolve the bindings of their
  own target channel instead.
- **Being in the destination is not access to everything an agent knows.** An
  `AgentBinding` says the agent may participate in that channel; it does not
  publish the agent's private conversations, documents or other source scopes
  to the channel's readers. A public-channel reply derived from a private DM is
  therefore still restricted even when the agent is visibly in the channel.
  The shareable placeholder describes that exact fact — its sources are not
  available to everyone who can read the channel — rather than claiming that
  the agent or the readers are missing from the channel roster.
- Sink writers today: the transcript window (transitive), memory recall, every
  knowledge-base read, the conversation searches, attachment reads, every
  executor `mcp.*` result, an admitted checkpoint — and a checkpoint on resume
  is a read path too — and every DeepWater read of a research this team opened
  (`research_scope_get`, `research_scope_reply`, `research_status`,
  `research_report`), which first requires that its requester still reaches
  everything the research was built from and then adds that whole basis and its
  private-conversation authors ([deepwater.md](deepwater.md) → "Agents and
  briefs").
- **Host program output is the launch conversation's.** A local program an
  executor fronts (`mcp.tools` / `mcp.call`) answers from the person's own
  machine — a signed-in browser profile, private repositories — so it is not
  public web. Launching local apps in a conversation — a person-launched
  executor run in it, from the launcher's **Local apps on this machine** — is
  the person's consent to show that machine's program output to that
  conversation's audience, and nowhere else. An agent cannot bind an executor
  on its own, so the consent is always a person's; for a standing policy, the
  author's confirmation is that consent, and host output is admitted only to
  the ticket's comments and its work thread
  ([ticket-work-machine-access.md](ticket-work-machine-access.md) → "Host
  output stays on the ticket"). Every `mcp.*` result
  stamps the run's sink with the launch conversation's scope before its
  command is sent (`worker/src/run/executor-host-output.ts`; today the run's
  own channel).
  The channel is stamped **even when it is public**, the one exception to the
  public-channel skip above: that room's history is the organisation's to
  read, but the program's output was consented to that room alone.
  - A reply into the same conversation is unaffected: the destination
    implies its own channel.
  - A write onto a project board is allowed when the launch conversation is a
    live, ordinary, public channel of that very project, because every project
    reader can already read it: `assertProjectWriteDestination` treats that
    channel scope as implied only as a host-output stamp — the sink keeps
    those apart (`addHostOutputScope` / `hostOutputScopes`) — and still
    refuses one that carries private-conversation lineage. The same public
    channel scope from any other source, such as a recalled memory's channel
    audience, stays refused as before. A protected channel's or a DM's host
    output never lands on a board.
  - Anything else — another channel, a DM to someone else, another project's
    board — is restricted by the basis like any other privileged source.
  - A run resumed after its worker died is stamped when its toolset is built
    if the pair already has ToolCalls, because its window replays those
    answers.
  - A checkpoint continuation ("keep going", an auto-continuation, a resume
    after an approval) inherits the stamp, because the note may quote program
    output verbatim. The checkpoint's persisted basis cannot carry it — the
    writing run's reply basis subtracts its own channel, which is the stamp —
    and persisting the channel into `RunBasisScope` would withhold a public
    room's own run records from the people who can read the room. So
    `loadRunCheckpointForRun` re-derives it structurally
    (`loadCheckpointHostOutputScopes`): the writing run, and every run whose
    checkpoint it consumed back along the chain, stamps its own channel if it
    has a ToolCall on an `mcp.*` operation, and `admitRunCheckpoint` adds
    those to the resuming run's sink as host output. The viewer check that
    admits the checkpoint reads its basis alone: the person resuming is in
    the conversation the output was consented to.
  - Task Set processor search binds its own `ollama-search` and is no launch
    in a conversation; it passes no scope, and its results travel under the
    set's classified disclosure.
  - A program's images are files of their executor command
    ([file-storage.md](file-storage.md)) and are served to a person only as
    the run is: `canAccessAttachment` asks the run's conversation through the
    disclosure-readable thread predicate, then `canUserReadRunDerivedRecord`,
    and nothing else — not the uploader, not an organisation admin. A surface
    that lists them (the thought log's tool lines, `ToolCallEntry.attachments`)
    asks the same run-level question first (`canReadRunExecutorImages`), so a
    reader who may see the call but not the image is shown no ref at all.

  `worker/test/db/executor-host-output-disclosure.test.ts` pins the three
  board outcomes and the sales walkthrough's refusal of a protected planning
  channel's research; `executor-host-output-checkpoint.test.ts` pins that a
  continuation, and the one after it, still restricts another room and
  refuses another project's board.
- **A channel directory read stamps its non-public rooms — except a DM named
  by its label alone.** `channel_list`, `channel_find`, the channel labels
  `agent_list` names, the room `agent_bind_channel` links and the record
  `channel_update` echoes all resolve channels through the acting person's
  own memberships, so a private or protected room among them is scoped
  material and stamps (`recordChannelDirectoryRead`,
  `worker/src/run/pa-tools/message-search-basis.ts`). The one exemption is a
  direct message the requester is in, named by its label and nothing else:
  stamping every DM a list returned put each of the person's conversations
  with their assistants into the run's basis, and the project write gate then
  refused every ticket write for the rest of the run although no word of
  those rooms had been read. A DM row that prints free text its members wrote
  — `channel_list`'s `topic=` — stamps like any other room, and
  `channel_update` echoes a topic or description only when that call wrote
  it. The trade-off, accepted: the label of a DM the requester is in (for a
  person-to-person DM, who it is with) can reach a reply that people outside
  it read, when the requester asked for their own channel list in a shared
  room. What a channel *holds* always stamps, DM or not: its messages, its
  attachments' names and bodies, the conversation searches (whose channel
  matches also carry a thread title), and the decision policy and agent
  participants `channel_list` returns for one `channelId`.
- **Recall under a project write is narrower than containment.** Containment
  admits the destination's team and channel audiences, which a reply may carry
  but the project write gate (`assertProjectWriteDestination`,
  `worker/src/run/pa-tools/ticket-context.ts`) refuses, and a thought whose
  audience passes it can still carry the private conversation it was captured
  from. So when containment applies **and** the run was offered a
  project-delegated tool that writes (`holdsProjectWriteTools` in
  `run-setup.ts`: lent, offered, not `safe`), recall admits only lineage scopes
  `{organization, project:<channel.projectId>}` —
  `constrainScopesToProjectWrite` narrows the search, and
  `isWithinProjectWriteScopes` judges each recalled thought's whole lineage and
  each recalled history message, so a team, channel or user audience or any
  private-conversation source is simply not recalled for that run
  (`requiresProjectWriteRecallContainment`, `execute/memory.ts`). That
  judgement runs after the search, so such a run's search goes
  `PROJECT_WRITE_RECALL_DEPTH` (3) times deeper — 15 thoughts instead of 5, 36
  history candidates instead of 12 — and keeps what survives, in rank order, up
  to the normal count; only those enter the basis. Searching at the normal
  depth, a requester whose best matches had all been fed by a private DM got
  nothing back while project knowledge sat just below the cut
  (`worker/test/db/project-write-recall-depth.test.ts`). Only the thoughts it
  keeps are marked accessed and logged as recalled
  (`searchAndLogThoughtsInScopes`'s `retain`, `packages/memory/src/search.ts`):
  `last_accessed_at` feeds the recency term of every later ranking, so bumping
  the DM-fed thoughts the run refused would keep lifting exactly those — into
  the next non-write run's basis, and back above the cut of the next
  project-write one. A history candidate costs no passage read unless its seed
  is one the run may take and still fits the budget, so the hits the deeper
  history search passes over cost it no neighbour reads
  (`retrieveRelevantHistory`, `execute/history-recall.ts`). The gate and every
  other run are unchanged: a run without write tools recalls exactly as before,
  at the same depth, and a delegate in its own home is not contained at all. The
  trade-off, accepted: such a run does not remember what the requester said in
  a private DM, nor its own room's channel memories, even where its reply
  alone could have carried them. The alternative — letting the gate accept a
  source when every member of it can read the project — compares sets of
  people, which this machinery deliberately never does.
- **Document versions retain their source boundary.** A `KnowledgePageVersion`
  stores its own basis scopes and private-conversation source authors. A reader
  first passes the document home's ordinary entitlement, then must satisfy the
  exact version basis before the title, body, search snippet, download, comment
  surface, historical version, recent-page row, summary, or live document
  output can be returned. A version created from a run stamps the consumed
  basis and private source rows; a successor unions rather than discards its
  predecessor's rows. Until comments, labels and page cards are individually
  version-bound, list/search/recent queries conservatively require every
  retained version to be readable before returning the page; a later exact
  version selector may narrow that rule without exposing pending-draft
  metadata. An explicit unknown private author fails closed for that
  version, while ordinary legacy versions with no private-derived marker remain
  unrestricted. The database unique index treats a null author as equal so an
  unknown marker cannot multiply into ambiguous lineage. A source channel must
  be present in the retained basis and both channel and known author must belong
  to the document organisation before persistence. Existing message grants do
  not widen document versions; wider publishing/export awaits an exact-content
  authorization route.
- A withheld row carries no metadata, reactions, or reply participants; the
  share affordance goes only to a reader who satisfies the basis directly,
  never a grant recipient. The WS/SSE terminal events carry `restricted: true`
  instead of a preview.
- The agent Messages tab merges at most 100 ordered candidates from two
  independently indexed history arms. Direct messages read at most 101 rows;
  run-derived messages read at most 101 rows for each distinct conversation the
  agent ran in, then merge in the database service. This bounds work by the
  agent's conversations rather than by any conversation's complete history; a
  very widely deployed agent therefore costs proportionally more per page. It
  resolves the viewer once, checks destination-channel reach in that same
  bounded read, and uses the runtime's page-wide grant accessor, including
  histories whose rows land in different destination channels. Its encrypted
  continuation is bound to the current agent, organization and user, so it may
  advance past withheld candidates without exposing their keys, counts, or
  metadata. A later page always re-evaluates live membership, grants and grant
  expiry; a revoked grant therefore withholds the row on that request rather
  than trusting a prior page.
- A manual share publishes the content-free `message.disclosure.changed` event
  to the destination channel scopes. Open readers refetch the reply through
  the current predicate; granting it never puts its text on the realtime wire.
- A delivered DeepWater research is retained output of its product run. The
  Knowledge version it imports carries the run's full `source_scopes` and
  `disclosure_sources`, and its stored `report.md` / `sources.csv` are served
  only behind `isDeepWaterRunVisible` — the same predicate as the run's list,
  detail and card ([deepwater.md](deepwater.md) → "Artifacts").
- A task, plan, or child-agent activity row linked to a run is a retained run
  output: its reader must satisfy both the run channel entitlement and that
  run's disclosure basis. A task without a run keeps ordinary task visibility.
  That holds on every read that returns the row, list or single: the task list,
  the task detail, the board task list (`listBoardTasksForUser`,
  `api/src/services/tasks.ts`, used by `GET
  /api/projects/:projectId/boards/:boardId/tasks` and the MCP
  `nessie_board_get`) all leave an unreadable row out. `listBoardTasks`
  (`@nessie/team-admin`) is unscoped placement and must not be returned to a
  viewer directly.
- Message search reach is the same for every role — organisation and team
  owners and admins included — and follows Slack/Teams: public standard
  channels plus the conversations the searcher is a member of. A direct message
  or a system room (`systemChannelType` set: Personal Assistant, agent mailbox,
  external agent) is participant-only even when its visibility says public
  (`searchMessages`, `api/src/services/message-search.ts`). The channel read
  predicate (`getVisibleChannel`, `api/src/lib/request-helpers.ts`) must stay
  aligned with this rule. Both leave out a soft-deleted channel
  (`Channel.deletedAt`, stamped by a channel delete and by its project's
  delete) for every searcher, members of it included.
- `buildVisibleChannelWhere` (`worker/src/run/pa-tools/access.ts`) returns a
  top-level `OR`. Combine it with other predicates through `AND: [...]`, never by
  spreading it beside a second `OR`: the later key replaces the visibility rule
  and the query returns private channels the person never joined (this is how
  `channel_find` leaked). It also carries `deletedAt: null`, so every worker
  reader built on it — `channel_list` with `includeArchived`, attachments,
  message destinations, conversation search — never reaches a soft-deleted
  channel.
- A shared agent with private-conversation material cannot place that material
  into an external browser URL or page (`browser_open` and `browser_act`). Those
  browser verbs have no original-author-bound, exact-content disclosure grant;
  personal-assistant and public-context browser work keep their ordinary flow.
- **A private conversation's author, rather than its agent's owner or another
  reader, decides export.** `MessageDisclosureSource` carries the source
  channel and each human author whose private turn entered a derived message.
  A one-message grant needs that exact single author; a multi-author private
  conversation therefore stays withheld until each author has a deliberately
  scoped route. Standing grants never cover private conversation lineage. An
  explicit request can create the existing one-message grant automatically,
  but only after the utility model judges the current author-authored request
  against the exact proposed content and destination and the server proves the
  requester is that recorded source author. Read-time grant evaluation repeats
  that author check, so grants made before lineage existed cannot release a
  private conversation and a valid author can renew the same one-message grant.
  The acknowledgement submits the exact rendered reply body; a concurrent
  replacement revokes earlier grants and a stale acknowledgement is refused, so
  a grant never covers content its author did not inspect.
  Missing lineage fails closed for sharing. Transcript, attachment, checkpoint,
  memory and conversation-search reads carry known lineage forward and mark an
  older/agent-derived source with no durable author as unknown; a known turn in
  the same channel cannot re-attribute it. `RunCheckpointDisclosureSource` and
  `ThoughtDisclosureSource` retain only server-derived channel-and-author
  provenance; a checkpoint writes its body, basis, and source rows atomically,
  while a legacy checkpoint or thought without source rows remains unknown on
  recall. Thought capture may union provenance from its actual input, but never
  invent an author from channel membership, an actor, or metadata. A handoff
  brief, delegated subtask assignment, or peer-delegation mailbox brief is a
  hidden trigger message, never an untracked prompt override:
  it stamps the inherited basis and these same original authors before the child
  run receives its bytes. Public conversations create none. A DeepWater wake
  kickoff is the same kind of hidden trigger: it carries the research run's
  full, unsubtracted `source_scopes` and `disclosure_sources`, and the woken
  run admits them as its trigger's lineage.
- A queued trigger owns its author provenance even after it leaves the recent
  transcript window. `admitTriggerMessageLineage` reads the trigger's own
  channel, role and raw-human author fields before its content or pinned
  instructions enter a prompt; hidden system briefs keep their stored lineage.
- Since viewer channel scope comes from `ChannelMember` rows alone, adding or
  removing one of those rows is itself a disclosure decision: it takes
  `canModifyChannel` (`packages/team-admin/src/resource-authority.ts`, applied
  in `api/src/services/channel-members.ts`), the same gate renaming and
  archiving take — any member of the channel, or an organisation owner or
  admin — with one carve-out: a person may always remove themselves.
- Spec and build status:
  [docs/plans/2026-08-11-disclosure-boundaries-build.md](../plans/2026-08-11-disclosure-boundaries-build.md).
- `@nessie/runtime`'s `publishMessageEnvelope` (`packages/runtime/src/message-envelope.ts`)
  is the one `message.new`/`message.reply` envelope for both the API and the
  worker — six literal payload objects used to retype it at each call site.
  What stays with the caller is the scope set, because who may see this is a
  disclosure decision the destination owns, and the failure policy, because only
  the caller knows whether a dropped announcement costs a refresh or a run.
- Subscription-time authorization is only half the rule: realtime delivery
  (`api/src/realtime/delivery-entitlements.ts`) re-authorizes organization,
  agent and thread-stream scopes **per event**, the same way channel and
  dashboard scopes already did, because revocation takes effect on the next
  request and a WebSocket or SSE stream may never make one. Each predicate is
  memoized for `REALTIME_ENTITLEMENT_TTL_MS` (5 s) so a token-per-delta stream
  costs one query per window rather than one per token; a revocation stops the
  stream within that same 5-second window, not at connect time.
- Deactivation keeps `ChannelMember` rows as history, and `getVisibleChannel`
  asks only "public, or a member". So the per-connection channel gate in
  `api/src/realtime/notification-delivery.ts` — which the WS, user-SSE and
  thread-stream lanes all ask — first requires the memoized organisation gate
  (`canAccessOrganizationEvent`: an `OrganizationMember` row with
  `deactivatedAt: null`). A deactivated member's open stream stops within one
  window, at the cost of at most one extra membership query per window per
  connection.
