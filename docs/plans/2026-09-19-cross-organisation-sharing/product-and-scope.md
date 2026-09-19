# Product model and resource scope

Part of the [cross-organisation sharing plan](overview.md).

## 1. Terms and invariants

- **Source organisation**: the existing UOA organisation bound to the Nessie
  tenant that owns the project. **Source team**: its one UOA team identified by
  the project's verified `Project.teamId` and stable external binding.
- **Recipient organisation/team**: a different UOA organisation and one of its
  existing UOA teams. A share is addressed to the team's stable identifier,
  never its name, email domain, current session, or a list of individuals.
- **Project share**: a grant to the project's share-eligible content, including
  all its present and future boards and the resources listed below. The project
  still belongs to exactly one source team.
- **Board-only share**: a grant to one board's owned task pool, columns, selected
  field/iteration projections, and explicitly published board resource links.
  It grants no project membership, project enumeration, or sibling board access.
- **Read-only (RO)**: read the eligible content, use filters/search within it,
  and download eligible files. It does not allow comments, reactions, edits,
  assignment, watching on another person's behalf, or execution.
- **Read-write (RW)**: RO plus the explicitly listed collaboration mutations.
  It is not a native `ProjectMember.role`, an ownership role, an invitation to
  join the source organisation, or a right to administer connections.
- **Available resources**: content owned by this project and allowed for its
  shared audience, with all independent provenance/private-source checks still
  applied. Mere discoverability, a hyperlink, or access available to the source
  creator does not make something a project resource.

Initial scope is two already provisioned, UOA-bound teams on the same Nessie
installation. Sharing across separate Nessie installations is federation and is
not covered. A no-IdP install retains its one unbound tenant and existing local
membership rules; it does not fabricate another organisation to use this feature.

No new UOA organisation, team, user, profile or membership record is created by
sharing. Existing stable product bindings can be referenced. Recipient acceptance
must resolve its team through UOA, not create a local shell for a guessed team.

## 2. Who controls and uses a share

Recommended authorization matrix (all checks are live and scoped to the named
organisation/team; a recipient organisation owner is not a source administrator):

| Actor | Offer/change/revoke outgoing grant | Accept/decline/leave | Use content |
| --- | --- | --- | --- |
| Native source project member passing `canModifyProject` | Yes, subject to source external-sharing policy | No recipient authority implied | Existing native rights |
| Source org owner/admin | Yes, without silently joining the project | No recipient authority implied | Existing native rights and independent private boundaries |
| Source team manager outside project, ordinary source non-member | No; team role alone is insufficient | No | Existing public/limited project rights only |
| Recipient team manager with UOA-proven exact-team management capability | No | Yes for that team | Only if also a live member of that recipient team |
| Recipient org manager with UOA authority to manage that exact team | No | Yes | No content bypass when outside the team |
| Ordinary recipient team member | No | No; may hide a shortcut personally | Accepted grant, bounded by RO/RW |
| Recipient org member in another team; removed member; anonymous actor | No | No | None; not even source project metadata |
| Agent or paired client | No independent ownership power | No autonomous acceptance | Effective human's current grant AND its existing tool/agent gates |

Keep the native equal-rights project rule: all source project members can manage
outgoing shares unless an explicitly introduced source policy forbids external
sharing. Restricting creation to source owners only would change that standard;
do not silently make that change in the route. Org owners/admins may apply a
source-org policy through the existing settings cascade; team policy can narrow
only where the cascade allows it. No new local team-role authority is added.

The recipient grants participation to **every current member of the named team**,
including future members; show this sentence at offer and acceptance. Removal,
deactivation or credential revocation removes access at the next authorization
boundary. Acceptance does not copy the roster or freeze the accepting person's
membership. A manager leaving later does not erase an institutional grant;
remaining authorized managers can manage it. Team deletion/suspension is different
and stops the grant. UOA outage fails closed, never falls back to a stored roster.

No transitive sharing. Recipients cannot issue another grant, add source project
members, change resource visibility, publish additional linked resources, transfer
ownership, remove the source project/board, or alter the share's audience. The
source UI shows separate grants rather than silently combining them. If several
accepted grants apply, any complete live grant may authorize an operation; never
assemble an operation from incompatible partial grants. The UI shows the maximum
effective collaboration rights and their origins. Revoking one grant does not
revoke an independent grant or native membership, and the confirmation says so.

## 3. Lifecycle and addressing another organisation

Use a **resource-share offer**, not a UOA identity or membership invitation.
Recommended initial addressing flow avoids a cross-customer directory:

1. A recipient team manager obtains its stable team reference from Team Settings
   using its live UOA context, and gives that reference to the source manager.
2. Source Sharing accepts the exact reference. The server checks an existing
   product binding and records a pending offer, returning only a generic result
   until recipient authority resolves the target. Never enumerate tenants or
   return a foreign roster for a typed name. Rate-limit attempts by actor/org.
3. The authenticated recipient team manager sees the offer in its Incoming
   Sharing view, validates source identity, resource scope, future-content rule,
   mode and cost boundaries, then accepts or declines. Source identity labels
   require a UOA-supported permitted display lookup; stale local mirrors are not
   a new display store. The exact display contract is a prerequisite.
4. Acceptance atomically activates exactly the offered revision. Stale acceptance
   fails with a refresh requirement. Pending offers expose no resource content.

If product wants copyable offer links, they locate an offer only; they never grant
access, contain a credential, or allow the first opener to choose a recipient.
Offer expiry defaults to seven days. Active grants have no automatic expiry by
default; optional expiry is supported explicitly and enforced on every request.

States: `pending`, `active`, `declined`, `revoked`, `expired`; operational health
is separate (`healthy`, `suspended`) with a stable reason and revision. Revoked
or expired grants are never revived: re-sharing creates a new grant/offer.
RO-to-RW requires recipient acceptance of the increased authority/cost risk.
The old RO revision may stay active until acceptance; keep proposed and effective
mode distinct. RW-to-RO, source revoke, recipient leave and policy deny apply
immediately without another approval. Project-to-board or board-to-project changes
are new offers, never a mutation that silently expands the scope.

## 4. Subscriptions and cost attribution

Do not store tariffs, credit balances, subscription status, seat copies, payment
consent or plan names on a share. UOA owns them. The grant is a Nessie permission;
UOA commercial service eligibility and Nessie operation-specific quotas are
additional requirements, not alternate authorization.

Recommended launch policy: both teams must have UOA-authorized Nessie service
access for the relevant operation; a recipient never uses the source team's
subscription as a guest login. Whether receiving RO shares is free is an open
UOA product decision. Source team entitlement permits publishing; recipient team
entitlement permits receiving/using; the plan does not invent plan tiers.

`confirmUoaDirectServiceAccess` confirms the signed-in person's exact team at
login/switch and records direct access. It must never be called as an arbitrary
source-team entitlement probe or with a fabricated source-team actor. Agree an
upstream read-only, product-scoped eligibility contract before adding commercial
sharing gates; no such cross-team contract was established by this inspection.
Transport/auth/revocation freshness and suspension behavior must be part of it.
If UOA decides sharing needs no additional commercial gate, document that explicit
decision and retain ordinary service admission; do not infer it from a session.

Resource rows and uploaded bytes stay in the source project. FileService charges
source storage limits for writes, with the real recipient uploader as provenance;
show the source-storage consequence when accepting RW. Existing source sync and
automations retain their source admission and billing origins. Shared edits are
marked external collaboration so no agent watcher, trigger or integration silently
spends source credits or exports content because an external user moved a card.

Paid agent execution is separately admitted: recipient personal assistants acting
for recipient people retain recipient billing identity and policies; a source
automation retains the source's explicitly authorized origin. No attribution is
changed by switching the resource context. Initial grants cannot authorize remote
write-back, new unattended runs, new connector calls, or source-agent assignment.
Later support must pin payer, policy, content audience and authority at admission,
make the cost decision visible, and never fall back to another team's credits.

Suspended service/policy eligibility blocks the affected share, not all unrelated
native work. Persist a remedy such as `source_service_unavailable`,
`recipient_service_unavailable`, `team_unavailable` or `policy_disabled`. An
authorized manager explicitly retries/resumes after the underlying condition is
fixed; login alone never heals it. Revocation and leave remain reachable even if
commercial use is suspended. A transient UOA transport failure returns a retryable,
content-free failure; do not permanently suspend every share on a single timeout.

## 5. Exact content and mutation scope

This table is the proposed public contract. Independent resource and disclosure
checks always apply, including to titles, counts, thumbnails and historical data.

| Resource | Whole-project share | Board-only share | RW mutations and limits |
| --- | --- | --- | --- |
| Project shell | Name, description, eligible navigation and source attribution | Minimal source project label and board breadcrumb only; no project members/counts/settings | No rename/delete/transfer/member management of the project |
| Boards and columns | All live project boards, columns and their entitled tasks | Exactly the selected board and its columns | Edit/reorder columns and board name/style within scope; create boards only with a project RW grant. Source-only deletion, default-board changes, sharing, source mappings and filter administration |
| Tickets, checklist, lifecycle | Eligible tasks across project boards, including archived tasks only when explicitly requested | Tasks owned by the granted board via `boardTaskPoolWhere`; archive is not deletion | Create/edit native tasks, priority/dates/allowed fields, checklists, status, archive/unarchive and intra-scope movement. Source-only project-wide destructive actions; never mutate hidden fields |
| Iterations | Project iteration definitions and counts computed from visible tasks | Only source-selected board iteration references and minimal name/date/state projection; no project-wide totals | Project RW may create/edit ordinary iterations; board RW may assign eligible referenced iterations, not edit a project-wide definition |
| Custom fields | Project definitions/options and visible task values | Explicit board field allowlist, selected safe options and validation constraints; suppress other keys even on an entitled task | Edit eligible values; project RW may manage native field definitions, with audience-impact checks. Board RW cannot change a project definition or provider mapping |
| Task comments and reactions | Only a task-owned comment resource, if present, under the task gate | Same exact task scope | Create/edit own comments and react; delete own content only. No widening to a run's conversation. Current TaskDialog has Documents/Checklist rather than a proven standalone comment model: see delivery decision |
| Standard project channels | Public, non-system project channels explicitly classified as project collaboration content | None | Project RW may post through a share-aware participation gate. Do not create ChannelMember rows: that would grant channel-management powers. No channel configuration, bindings or member changes |
| Protected channels, DMs, private agent conversations | Excluded unless separately authorized by their own exact audience rules; project share does not authorize them | Excluded | No bypass of participation, authorship or private-source export consent |
| Documents/folders/files | Project-visible KnowledgeSpace/pages owned by this project, not personal/team/org content merely appearing in a browser | Only explicit source-published page/folder or task-file links to this board; no implicit link-following, ancestor listing or sibling pages | Edit eligible documents/comments with existing version rules. Create project documents with project RW; create board documents only in an explicitly board-bound home/resource link. Source-only widening links, moves to a broader audience and visibility changes |
| Attachments/previews/downloads | Files whose entitled project document or message references authorize the bytes | Files of the exact entitled board resource/version; a UUID or markdown link is insufficient | Upload via FileService to a validated target; bytes and quota attributed to source. No unrelated/unlinked uploads exposed, no storage key returned |
| Dashboards | Project-owned, explicitly publishable output with independent dataset/source provenance; never connector config | Excluded initially | View output only initially; neither mode gains refresh/execute or credential-edit rights. If provenance cannot be proved, withhold the dashboard rather than exposing a cached dataset |
| Agents | Minimal identity attributed to readable work; safely exposed project-channel interaction only after execution phase gates | Minimal attribution on tickets, not agent profile/history/tool access | No transfer/edit/binding/assignment that starts a source agent from share rights alone. Recipient PA task/document tools may operate within live grant after disclosure phase |
| Plans, runs and approvals | Only content whose run/conversation and full provenance independently pass; approval cards stay in their owning readable conversation | No plan/run/approval access inherited from a ticket or board | RO/RW never grants approval resolution, run restart/continue/cancel or source execution authority; existing approver/run-control gates remain separate |
| Triggers, workflows, watchers | Safe outcome on entitled work, not raw schedules/prompts/configuration | Same, restricted to this board | Self-follow can be enabled with RO as a personal preference; no watching for others. External mutations cannot trigger side effects until source owner explicitly enables the specific automation path |
| Sources and integrations | Safe provider label, read-only/write-restricted state, freshness and generic health of mirrored content | Only provenance/freshness of sources contributing entitled cards; no empty default-board source catalogue | No attach/detach/reconfigure/sync-now/remote search or external writes from share alone. Provider-mirrored fields are read-only initially; avoid local edits that sync overwrites |
| Secrets, OAuth tokens, executors, browsers, connected mail | Never inherited | Never inherited | No credential, tool-grant, mailbox, executor, browser session or billing management rights |
| Activity and audit | Allowlisted events for entitled resources, with authorized actor identity | Same for exact board/resources | No source org audit, prompts, tool arguments, usage telemetry or hidden before/after fields. Shared activity is a filtered presenter over existing events |
| Links, parent/child tasks, dependencies, references | Dereference only if target separately entitled | Same; cross-board parent/child rows/labels/counts are absent | Linking does not publish target. Validate source and target before mutations; no navigation fallback to an unshared board |

Whole-project sharing includes **future eligible content**; say so when offering
it. Existing private resources remain private. The source must see which classes
are excluded or withheld rather than an unqualified promise that every byte will
be available. Broadening a resource to project-visible is an explicit publication
action with the project's external audiences shown. Board links and allowed field
options are product-owned resource publication policy, not copies of identity.
Do not infer a board document relationship from a task title, agent assignment,
run metadata, text search, or a URL embedded in content.

An externally shared board is its whole owned pool, not a filtered subset. Saved
board filters remain presentation and never become an ACL. Share preview explains
that archived and currently filtered-out owned tasks can still be reached by
authorized search/detail. If product instead wants sharing a filter result, that
is a different dynamic-row authorization feature and needs its own design.

## 6. The default-board rule

Preserve `Task.status` as lifecycle truth and `resolveBoardPlacement` as server
placement authority. A non-default board owns `Task.boardId = board.id`; the
default owns its explicit id **and** null `boardId`. Always combine that pool with
source project/organisation predicates; an unqualified null-board query is a leak.

Native board-unaware writers continue landing on the default. A share-aware writer
must name or receive a server-pinned board. A board-only request without board
context is refused, never defaulted; the route can inject the already authorized
board into the common task service. The same applies to PA/MCP creates and bulk
operations. Default-board sharing therefore intentionally includes future
board-unaware writes; source confirmation must explain that wider exposure.

Current `moveProjectTaskToColumn` can move between same-project boards. Require
write access to both source and target board, then verify the destination's
audience may receive the content and all its retained disclosure basis. Two
independent board grants do not establish data-export permission between their
audiences. Source moves into a shared board show the new audience; moving out
revokes board-only access to the ticket and its task-bound resources. Do not
relabel a generated answer's original provenance when its task changes boards.

Current board deletion returns tickets to the default. Only native source
managers may delete; atomically end that board's shares before moving tasks.
Validate the default board's audience as for an explicit move: if that board is
shared with a different team, deletion must not disclose the moved work. Refuse
until unsafe tasks are deliberately relocated or their publication is authorized.
Never turn the old board grant into a default-board grant. Changing the default
board must explicitly materialize the old default's null-owned tasks first or
otherwise preserve ownership transactionally; test the current setter before
adding sharing, as silently moving null tasks would also change their audience.

## 7. Owning surfaces and in-context doorways

| Capability | Home | Doorway where the question arises |
| --- | --- | --- |
| Offer, inspect mode/audience, change, revoke project share | Project Settings → Sharing | Project header **Share** and persistent external-audience badge |
| Share one board and select safe field/resource projection | Board Settings → Sharing, same scoped Sharing component | Working board header **Share board** / Configure; Board directory row action |
| Review incoming offers, accept/decline/leave, recover | Team Settings → Sharing → Incoming | Shared Projects empty state and generic bell alert linked to exact offer |
| Recipient work and discovery | Projects → Shared with your teams; reused ProjectView or board-only view | Sidebar entry after acceptance; recipient team settings **Open**; share deep link |
| RO/RW understanding | Shared project/board header | Visible **Read-only** or **Can edit** plus **Shared by source team / org**; mode change alert |
| Documents and files | Existing Project Docs reader scoped to project grant, or board resource subset | Board/task Documents action opens exact authorized resource and returns to board |
| Published board resources/field choices | Same Board Sharing panel | Task Documents **Make available on shared board** for source managers; field visibility summary |
| Activity | Existing task activity / resource-scoped Sharing activity | Share details **Activity**, affected ticket update |
| Subscription/policy suspension and repair | Same Sharing detail, with reason-specific action | Header state, bell, source settings row; billing link goes to the acting team's UOA billing surface |
| Agent-mediated proposal approval | Existing conversation approval card, copied into required approver PA rooms | Person asks PA to share; card opens exact share review. No approval-list screen |

Recommended recipient URL stays on the recipient tenant host and names its local
recipient team context plus the share id, for example
`/shared/:shareId/board?task=:taskId`. This is a registered route adapter to the
same project/board components, not a second implementation. It never impersonates
the source tenant or calls its context-switch endpoint. The exact route shapes,
parents and state/consume parameters must be registered together; cold Back returns
to Shared Projects, not a source project overview. An unknown/withdrawn share
retains the standard header with a generic unavailable state and safe Back.

Listings consider all teams the actor is currently entitled to in the acting
organisation; optional team filtering is explicit. Access is never narrowed to
the session's team by accident. Cross-organisation discovery uses the existing
explicit organisation switch, not a union of stale sessions. Showing a resource
never creates membership or changes the active tenant, branding or billing.

Reuse `ScreenHeader`, `ProjectPageHeader`, `TabBar`, `Dialog`/`ConfirmDialog`,
`Sheet`, `IdentityTile` resolving wrappers, `QueryState` and the established
pagination facade. Reuse board/task/knowledge components behind capability-aware
facades; never fork the views. Every disabled action names its remedy. No extra
operational dashboard or unrelated sidebar section is required.
