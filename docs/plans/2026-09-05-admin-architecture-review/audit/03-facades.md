# The domain-facade layer

## Verdict

The facade layer is more consistent than the doc's own prescription: the
de-facto convention across ~40 of 55 facades is one `hooks.ts` per domain,
importing types from `lib/api-client.ts` and keys from the centralized
`lib/query-keys.ts` — a shape the doc never describes but that a written,
CI-enforced test (`test/query-key-invariants.test.ts`) actively protects for
the query-key half of that contract. Where the layer breaks down is not
structure but two specific things: (1) response typing is almost entirely
hand-written (only ~9/55 facades import a type from `@nessie/schemas`) even
where an authoritative zod schema already exists and has already drifted from
the hand copy in at least one core entity (`ChannelRecord`); and (2) six
facades (`gmail`, `mail`, `agent-mailbox`, `settings`, `subscriptions`, and
the misnamed `agents/keys.ts`) built their own private query-key or
cache-helper mechanism that sits entirely outside the invariant test's reach.
Roughly 80% of the layer (structure, invalidation-only mutations, no
component imports) follows one clean convention; the typing gap and the
handful of escaped key/import patterns are where real risk concentrates.

## Findings

### F1. Core entity DTOs are hand-duplicated in `client-core` even though the authoritative zod schema exists and has already drifted
- Severity: high
- Category: typing
- Evidence: `packages/client-core/src/api-types.ts:38-72` hand-declares
  `ChannelRecord` (used by `admin/src/facades/channels/hooks.ts:11`,
  `admin/src/facades/threads/hooks.ts`, `admin/src/facades/global-agents/hooks.ts`,
  etc. via `lib/api-client.ts:38-145`'s re-export list). The authoritative
  schema is `ChannelRecordSchema` in `packages/schemas/src/team-records.ts:55-97`,
  which the API's own service layer treats as canonical
  (`api/src/services/channels.ts:11,21`, `api/src/contracts/team.ts:15-18`).
  The two are already out of sync: the schema has no `metadata` field at all,
  but the hand type adds `metadata?: ChannelMetadataRecord` (api-types.ts:32-36,
  43); and the hand type widens `systemChannelType?: 'personal_assistant' | string`
  (api-types.ts:49) where the schema keeps it a real enum
  (`SystemChannelTypeSchema.optional()`, team-records.ts:60) — `| string`
  erases the literal type for every caller. The same pattern repeats for
  `AgentRecord` (api-types.ts:158-208 vs. `AgentRecordSchema`,
  team-records.ts:212-279), `ProjectRecord` (api-types.ts:84-95 vs.
  `ProjectRecordSchema`, team-records.ts:105), and `TeamRecord`
  (api-types.ts:103-114 vs. `TeamRecordSchema`, team-records.ts:124) — four of
  the highest-traffic entities in the app, all with a canonical schema sitting
  one import away. Overall `api-types.ts` hand-declares 36 object types
  (`grep -c "^export type .* = {"`) against only 2 blocks that actually
  re-export from `@nessie/schemas`.
- Why it matters: this is exactly the pattern `docs/architecture.md:29-31`
  names ("Do not hand-write client DTOs that drift from shared runtime
  schemas... derive client-facing types from the authoritative schema") and
  it has already drifted once in a way that silently defeats type-checking
  (`| string`). A future schema change (e.g. narrowing `memberRole`, adding a
  required field) will not be felt by the client until it breaks at runtime.
- Fix: replace the 4 confirmed-canonical hand types in
  `packages/client-core/src/api-types.ts` with `export type X =
  z.infer<typeof XSchema>` re-exports from `@nessie/schemas`
  (`ChannelRecord`, `AgentRecord`, `ProjectRecord`, `TeamRecord`), deleting the
  hand copies. Then sweep `api-types.ts` for the remaining 32 hand types and
  check each against `packages/schemas/src` and `api/src/contracts/*.ts` for
  an existing schema before keeping it hand-written (a type with no
  authoritative schema anywhere, e.g. `AuthProviderDescriptor`, is a
  legitimate hand type and should stay).
- Fix size: M (packages/client-core is one file, but every facade importing
  the four types needs a compile check; no admin facade file itself changes)
- Risk: a field the schema marks optional but the hand type marked required
  (or vice versa) will surface as a new TS error at every call site — that is
  the point, and each such error is a place the client was already silently
  wrong. Full `tsc --noEmit` across admin, plus the existing
  `query-key-invariants.test.ts` (unaffected) proves nothing else broke.

### F2. Five facades keep a private query-key factory outside `lib/query-keys.ts`, invisible to the root-reachability invariant it exists to guarantee
- Severity: medium
- Category: structure
- Evidence: `export const gmailKeys = {...}` at
  `admin/src/facades/gmail/hooks.ts:33`, `export const connectedMailKeys =
  {...}` at `admin/src/facades/mail/hooks.ts:33`, `export const
  agentMailboxKeys = {...}` at `admin/src/facades/agent-mailbox/hooks.ts:19`,
  `export const scopedSettingKeys = {...}` at
  `admin/src/facades/settings/hooks.ts:19`, and `export const
  subscriptionKeys = {...}` at `admin/src/facades/subscriptions/hooks.ts:39`.
  `lib/query-keys.ts:1-33`'s own header explains the two rules a centralized
  module lets you check mechanically: every family root reaches its members,
  and no key is spelled twice. `test/query-key-invariants.test.ts:58-61` only
  inspects `Object.entries(queryKeys)` — i.e. exports of `lib/query-keys.ts`
  itself — for the root-reachability check, so these five families get no
  such check at all, and the raw-literal scan
  (`query-key-invariants.test.ts:166-184`) does not flag them either because
  they are still built by a factory function, just not the shared one. This
  is a different failure mode from the single flagged "1 known inline hit"
  (`pages/AuditLogPage.tsx:35`, which legitimately spreads a centralized
  factory and appends a local disambiguator, and is explicitly designed
  around in the module's own comment convention alongside
  `pages/PolicyPage.tsx:53`).
- Why it matters: this is precisely the class of bug the centralized module's
  header says it was built to stop — nothing enforces that
  `gmailKeys.sendGrants` or `connectedMailKeys.threads(...)` nests under a
  reachable root, so a future mutation that should invalidate every gmail
  draft view has no mechanical check that it actually does.
- Fix: for each of the five, fold the family into `lib/query-keys.ts`
  (`gmailKeys`, `connectedMailKeys`, `agentMailboxKeys`, `scopedSettingKeys`,
  `subscriptionKeys`) so they're covered by both invariant tests, exactly as
  `agent-todos/keys.ts:1-4` already does by re-exporting `agentTodoKeys` from
  the central module instead of redefining it. Where a family is legitimately
  scope-dependent at runtime (the module's own documented exception is
  `billingKeys`, `lib/query-keys.ts:150-160`), leave the *root* centralized
  and only the scoped leaf built locally, matching the billing precedent.
- Fix size: S (5 files touched in facades, 1 file grown in lib/query-keys.ts)
- Risk: nothing behavioral — these are pure renames/moves of already-correct
  key arrays. `query-key-invariants.test.ts` immediately starts covering them
  and should be run to confirm no root-escape was hiding.

### F3. `IncomingCallProvider` opens a second, independent `/api/events/stream` connection, reproducing the exact bug the shared fan-out was built to eliminate
- Severity: high
- Category: data-flow
- Evidence: `admin/src/facades/realtime/event-stream.ts:1-10` documents, by
  name, a past incident: "The alerts bell and the message notifier each used
  to open one anyway and parse every frame twice, each discarding the other's
  events — and since the route marks presence per connection, one of them
  closing marked the user offline while the other was still reading" — and
  the fix was the shared connection at `event-stream.ts:38-155`, consumed via
  `useEventStream` by `facades/alerts/hooks.ts:172`,
  `facades/calls/hooks.ts:77`, `facades/threads/activity-hooks.ts:137`, and
  `facades/notifications/useMessageNotifications.ts:469`.
  `admin/src/providers/IncomingCallProvider.tsx:197-238` re-implements the
  whole thing independently: its own `fetch(`${getBaseUrl()}/api/events/stream`,
  ...)` (line 211), its own `AbortController`, its own `lastEventId`
  bookkeeping, and its own reconnect loop — a second live connection to the
  same per-session presence-marking route.
- Why it matters: this is not a facade file, but it is exactly the class of
  bug `docs/provider-system-and-frontend-architecture.md` §6.2 warns about
  ("fetch agents one way in sidebar and another way in detail pages... keep
  hidden parallel stores") applied to a live connection instead of a cache:
  today it risks the same presence-flapping bug the shared stream was built
  to fix, and every future SSE event type has to be remembered twice.
- Fix: delete the duplicate connection logic in `IncomingCallProvider.tsx`
  (lines ~197-238ish) and replace it with `useEventStream({ enabled:
  Boolean(token && currentUserId), onFrame })`, moving `parseIncomingCallEvent`
  and the `dispatch`/`verifyLiveRing` logic into the `onFrame` callback — the
  same shape `facades/calls/hooks.ts:56-77` already uses for a very similar
  per-channel event.
- Fix size: S (one file; the shared primitive already exists and is proven by
  four other consumers)
- Risk: incoming-call ringing and reconnect-triggered `verifyLiveRing` must
  keep firing exactly once per event; e2e/call tests plus manual verification
  that a call still rings after a token rotation (the shared stream's
  documented reopen trigger, `event-stream.ts:123`) would catch a regression.

### F4. `lib/api-client.ts` never validates a response at the network boundary; only 5/55 facades opt into their own zod parse
- Severity: medium
- Category: data-flow
- Evidence: `admin/src/lib/api-client.ts` re-exports `createApiClient` from
  `packages/client-core/src/api-client.ts:82-248`, whose `request`/`requestEnvelope`
  functions (`api-client.ts:97-145` and below) do `JSON.parse` and hand the
  result back as the caller's generic `TData` with no schema check — the only
  `.parse(`/`JSON.parse` calls in that file are for the *error* envelope
  (`api-client.ts:66`). Contrast with the 5 facades that do validate:
  `facades/mail/hooks.ts` (`ConnectedMailAccountRecordSchema.array().parse(...)`),
  `facades/calls/hooks.ts`, `facades/executors/hooks.ts`,
  `facades/agents/realtime.ts`, and
  `facades/integrations/deep-water-research-launcher-navigation.ts`.
- Why it matters: `docs/architecture.md:29-31`'s guidance is "parse at
  process boundaries," and the client-side network response is as much a
  process boundary as the server's request body. Today whether a response
  gets checked depends entirely on whether the facade author remembered to,
  which is why it's 5 out of 55.
- Fix: this is primarily an `@nessie/client-core` change, but from the
  facade side: once F1's client-facing types are `z.infer` re-exports of real
  schemas, `createApiClient`'s `get`/`post`/etc. can call
  `schema.parse(payload)` when a schema is supplied, starting with the 4
  entities from F1. Until then, the 5 facades that already validate are the
  pattern to copy for any new facade around a canonical schema.
- Fix size: L (touches the shared `ApiClient` generic contract, used by every
  facade)
- Risk: a genuinely malformed/stale server response that today silently
  renders wrong would now throw; roll out schema-by-schema (as the 5 existing
  facades already do) rather than a blanket client-wide change.

### F5. `facades/agents/keys.ts` holds no query keys — it's a misnamed WebSocket/realtime helper file
- Severity: low
- Category: naming
- Evidence: `admin/src/facades/agents/keys.ts:1-99` exports
  `RealtimeConnectionState`, `AgentRealtimeRecord`, `resolveWebSocketUrl`,
  `mergeAgentSnapshot`, `snapshotToRecords`, `patchAgentStatusRecord` — all
  WebSocket-snapshot reconciliation logic, none of it a query-key factory.
  The actual query keys for agents live in `lib/query-keys.ts:35-59`
  (`agentKeys`), imported correctly by `facades/agents/queries.ts:13` and
  `facades/agents/mutations.ts:4`. `agents` is the one facade whose file set
  most resembles the doc's prescribed `api/queries/mutations/types/hooks`
  split (§5.2), which makes the misnamed `keys.ts` more confusing, not less —
  a reader following the doc's own example would expect `agents/keys.ts` to
  be the facade's query-key file.
- Why it matters: costs a few minutes of confusion every time someone new
  looks for "where are the agent-realtime WS helpers" or "where are the agent
  query keys," since the filename actively points at the wrong answer for
  both.
- Fix: rename `facades/agents/keys.ts` to
  `facades/agents/realtime-snapshot.ts` (or merge its contents into the
  existing `facades/agents/realtime.ts:1-405`, which already owns the
  WebSocket connection this file's helpers patch into). Update the two
  importers (`facades/agents/realtime.ts` itself, if it imports from `./keys`,
  and any test file).
- Fix size: S (1 rename, ≤3 import updates)
- Risk: none functional; a straight rename. `tsc` catches any missed import.

### F6. Facades import hook logic and types from `components/`, inverting the intended dependency direction
- Severity: medium
- Category: layering
- Evidence: 12 hits total. `useIsOwner` — a one-line derivation,
  `isOwnerSession(useAuthSession().me)` at `components/shared/OwnerGate.tsx:41`
  — is imported by 5 facades: `facades/projects/administration.ts:3`,
  `facades/search/hooks.ts:11`, `facades/integrations/hooks.ts:18`,
  `facades/tool-grants/hooks.ts:17`, `facades/apps/agent-access-hooks.ts:2`.
  `facades/messages/hooks.ts:7` imports `AgentMention` from
  `components/shared/MentionInput.tsx:45`, which itself only re-exports it
  from `@nessie/schemas` — i.e. the facade is reaching through a component
  file for a type that is already one hop from the shared schema package.
  `facades/designer/agent-designer-identity.ts:7` and
  `facades/designer/hooks.ts:5,9` import `AgentFormState`,
  `AgentDesignerActions`, and `DesignerPageContext` from
  `components/features/agents/designer/useAgentDesigner.ts` and
  `.../DesignerAssistantPanelContext.tsx` — both files are themselves hook/
  context logic, just misplaced under `components/`.
  `facades/apps/connect-hooks.ts:6,19,27` imports
  `normalizeConnectError`/connect-flow helpers from
  `components/features/apps/connect-error-copy.ts` and
  `.../connect-flow.ts`/`external-auth-launcher.ts`.
- Why it matters: `docs/provider-system-and-frontend-architecture.md` §5
  draws the layering as providers → facades → components, one direction. A
  facade reaching into `components/` for logic makes the facade's own public
  surface depend on UI-layer file moves, and is the reverse of the
  "components→pages" and "shared→features" reverse-import problems already
  flagged in the baseline.
- Fix, per case:
  - `useIsOwner`: move the one-liner into `facades/auth/hooks.ts` (132 lines
    today, room to spare); have `OwnerGate.tsx` import it back from there.
  - `AgentMention`: change `facades/messages/hooks.ts:7` to `import type {
    AgentMention } from '@nessie/schemas'` directly — no relocation needed on
    either side.
  - `AgentFormState` / `AgentDesignerActions` / `DesignerPageContext`: move
    these three type/value declarations into a new
    `facades/designer/types.ts`; the hook and context that produce them
    (`useAgentDesigner.ts`, `DesignerAssistantPanelContext.tsx`) are
    themselves not components and arguably belong under `facades/designer/`
    too, but at minimum the types they export should move so
    `facades/designer/*.ts` stops importing from `components/`.
  - `normalizeConnectError` and the connect-flow/external-auth-launcher
    helpers: move into `facades/apps/` (e.g.
    `facades/apps/connect-error-copy.ts`, alongside the existing
    `connect-hooks.ts`) since they are connection-flow logic the `apps`
    facade already owns the rest of, not presentation.
- Fix size: M (touches 8 facade files + their component-side counterparts;
  no behavior change)
- Risk: none functional if done as pure moves; `tsc` plus the existing
  `components→pages`/`shared→features` import-direction lint (if one exists,
  per the baseline's cross-layer import counts) should be extended to also
  flag `facades/ → components/` so this doesn't recur.

### F7. Optimistic updates with rollback exist but are the exception (3/55 facades), not the pattern; the rest invalidate-and-refetch
- Severity: low
- Category: state
- Evidence: across all facades, `onMutate` appears only in
  `facades/favorites/hooks.ts:60`, `facades/mail/hooks.ts`, and
  `facades/tasks/hooks.ts`. `facades/favorites/hooks.ts:46-77` is the
  complete, correct version: `onMutate` snapshots and patches
  optimistically, `onError` restores the snapshot
  (`queryClient.setQueryData(favoriteKeys.all, context?.previous)`), and
  `onSettled` reconciles with a real invalidate. The other 52 facades that
  mutate (`grep -l useMutation` finds 58 files) use plain
  `onSuccess: () => invalidateQueries(...)` — e.g. every mutation in
  `facades/agents/mutations.ts:32-157`, `facades/channels/hooks.ts:26-165`,
  and `facades/agent-todos/mutations.ts`. No facade mutation calls a toast or
  surfaces an error itself — `grep -l toast` across `facades/` only matches
  the two browser-notification files (`facades/notifications/*.ts`, unrelated
  to mutation error handling), confirming error handling is left entirely to
  the calling component's own `mutation.isError`/`error` state.
- Why it matters: this is not itself a defect — invalidate-and-refetch is a
  legitimate, simpler default — but it means the 3 optimistic exceptions are
  undocumented as a *pattern*, so the next author who wants instant UI
  feedback (e.g. for a checkbox or toggle) has no written convention to
  follow and either reinvents the rollback shape or skips it.
- Fix: no code change required; if/when a style guide for facades is
  written, name `facades/favorites/hooks.ts:46-77`'s
  `onMutate`/`onError`/`onSettled` triad as the canonical optimistic-update
  shape, and reserve it for mutations that toggle a small, already-cached
  list (favorites, mute state, read-marker) rather than ones that create a
  new server-assigned entity.
- Fix size: S (documentation only)
- Risk: none; this finding recommends codifying an existing convention, not
  changing behavior.

## Conventions observed

- A facade with a single, cohesive concern gets exactly one `hooks.ts`
  (~40/55 facades) exporting `useX`/`useCreateX`/`useUpdateX` hooks directly;
  there is no separate `api.ts` layer — `apiClient.get/post/put/delete` calls
  are inlined into each hook's `queryFn`/`mutationFn`.
- A facade that outgrows one file splits by **sub-resource or concern**, not
  by CRUD-layer: `knowledge/` (7 files: `file-hooks`, `comment-hooks`,
  `backlinks-hooks`, `wikilink-hooks`, `recent-pages-hooks`, `task-docs-hooks`,
  plus the base `hooks.ts`), `threads/` (10 files, split by
  document-stream/thinking/activity/retry concerns), `voice/` (9 files split
  by protocol concern), `apps/` (3 files: `hooks`, `connect-hooks`,
  `agent-access-hooks`), `users/` (4 files: `hooks`, `team-members`,
  `member-roster`, `organization-members`). This is the real "large facade"
  convention, and it works — it keeps each file readable and each concern
  independently testable.
- `agents`/`agent-todos` are the only two facades that split by CRUD-layer
  (`queries.ts`/`mutations.ts`/`keys.ts`/`hooks.ts`), matching the doc's §5.2
  prescription — but only `agents` genuinely needs it at 854 combined lines
  across a single entity with ~20 hooks; `agent-todos` (198 lines) does not
  need the split on size grounds and does it mostly for symmetry with
  `agents`, its parent domain.
- `lib/query-keys.ts` is the single source of truth for query keys almost
  everywhere (48+/55 facades import from it directly), backed by a real,
  narrow, well-targeted test (`test/query-key-invariants.test.ts`) that
  checks both "every family root is reachable" and "no raw array literal
  reaches `queryKey`/`invalidateQueries`/`setQueryData` outside the module."
  This is a genuinely good, working convention — the exceptions are the five
  facades in F2.
- Types for query/mutation payloads are imported from `../../lib/api-client`
  (which re-exports `@nessie/client-core`) far more often than from
  `@nessie/schemas` directly — only 9/55 facades reference `@nessie/schemas`
  at all, and several of those import it for enums/leaf types
  (`AgentEffortSchema`-adjacent literals) rather than full record shapes.
- Mutation error handling is uniformly left to the calling component (no
  facade calls `toast` or catches an error itself); the facade layer's job
  ends at exposing `useMutation`'s own `isError`/`error`/`isPending`.
- The realtime fan-out (`facades/realtime/event-stream.ts`) is the correct,
  working single-connection-per-session pattern, consumed by 4 facades via
  `useEventStream`; SSE frames are patched into the cache with
  `setQueryData` where cheap (calls, threads activity) and trigger a real
  `invalidateQueries` only where the shape is compound (favorites, tasks).

## Not a problem

- **`agent-cards`, `agent-mailbox`, `agent-todos`, `agents`, `global-agents`,
  `designer` are six genuinely different products built on one core domain,
  not one domain split six ways.** `agents` is the entity CRUD facade.
  `agent-todos` is a checklist/template sub-feature scoped by `agentId`
  (`facades/agent-todos/keys.ts:1-4` correctly nests under `agentKeys.all`
  rather than duplicating it). `agent-cards` is the presenter/response-card
  surface for interactive messages (`useAgentCard`,
  `facades/agent-cards/hooks.ts:8-16`), unrelated to CRUD. `agent-mailbox` is
  the hosted-email feature (`AgentMailboxRecord`, draft/send policy,
  `facades/agent-mailbox/hooks.ts:1-20`). `global-agents` is specifically the
  cross-client "open this blueprint's home DM" doorway
  (`facades/global-agents/hooks.ts:1-17`, `AGENT_DESIGNER_SLUG`). `designer`
  is the Agent-Designer chat wizard, which *composes* `agents`, `tools`, and
  `tool-grants` (`facades/designer/tool-catalog.ts:1-4`,
  `facades/designer/agent-designer-identity.ts:6-21`) rather than
  reimplementing them. Merging any of these would produce one large file
  mixing unrelated concerns — the opposite of what a merge should achieve.
- **`mail` vs. `gmail` vs. `mailbox-connections` are three different
  domains, not a naming accident**, though the boundary is worth double-
  checking against `components/features/connected-mail` (the component
  directory is named `connected-mail`, matching `mail/hooks.ts`'s own
  `connectedMailKeys` root, while the facade directory is just `mail` —
  a naming mismatch worth a rename to `connected-mail` for symmetry, but not
  a structural problem). `gmail` is specifically the owner-gated Gmail
  draft-approval surface (`facades/gmail/hooks.ts:8-13`, gated because a
  human must approve an agent-drafted send). `mailbox-connections` is raw
  SMTP/IMAP account management (`facades/mailbox-connections/hooks.ts:11-14`,
  discovery/connect/remove). `mail` is the unified read surface across both
  sources. `facades/mail/hooks.ts:19` does import `gmailKeys` from the
  `gmail` facade, which is a legitimate compositional cross-facade import
  (the same shape `designer` uses over `agents`), not a layering violation.
- **`users`/`team`/`organization`/`presence` are correctly separate**:
  `users` is the entity list, `team`/`organization` are two different scope
  levels of membership/provisioning (`team/provisioning.ts`,
  `team/invitations.ts` vs. `organization/hooks.ts`'s
  `organizationKeys.memberRoster`), and `presence` is the online/active-
  status layer keyed independently (`presenceKeys.all`,
  `lib/query-keys.ts:414-416`) because it updates on a different cadence
  (heartbeat) than any of the identity data. No overlap found.
- **`billing`'s scoped keys living outside `lib/query-keys.ts`
  (`lib/query-keys.ts:150-160` comment) is a documented, deliberate
  exception**, not an instance of F2: the module's own header names it and
  explains why (UOA org/team scope must be part of cache identity and is
  resolved beside the code that already has that scope). This is the
  precedent F2's fix should follow for any family that turns out to need
  runtime-resolved scope in its leaf keys.
- **The one inline `queryKey` construction the baseline flagged
  (`pages/AuditLogPage.tsx:35`) and its twin (`pages/PolicyPage.tsx:53`) are
  not raw literals** — both spread an existing centralized factory
  (`auditLogKeys.forAction(...)`, `policyKeys.rules`) and append a single
  `'page'` disambiguator, with a comment at each site explaining exactly why
  it's not the pattern the invariant test guards against. These are pages,
  not facades, and are correctly not flagged by
  `query-key-invariants.test.ts`'s raw-literal scan.

## Appendix: facade inventory

Columns: files (`.ts*` under the facade dir, depth ≤2) · lines (combined) ·
keys (`central` = imports `lib/query-keys.ts`; `own-file` = has a `keys.ts`;
`inline` = defines its own `XKeys = {...}` outside `lib/query-keys.ts`; `—` =
no query hooks) · schemas (number of files importing `@nessie/schemas`) ·
mutation pattern (dominant `onSuccess` behavior across the facade's
`useMutation` calls).

| facade | files | lines | keys | schemas | mutation pattern |
|---|---|---|---|---|---|
| agent-cards | 1 | 53 | central | 1/1 | invalidate |
| agent-mailbox | 1 | 138 | inline (`agentMailboxKeys`) | 1/1 | invalidate |
| agent-todos | 4 | 198 | own-file (re-exports central) | 2/4 | invalidate |
| agents | 5 | 854 | own-file (`keys.ts` = misnamed WS helpers; real keys central via `agentKeys`) | 4/5 | invalidate |
| alerts | 2 | 277 | central | 0/2 | invalidate |
| app-connection-requests | 1 | 41 | central | 1/1 | invalidate |
| approvals | 2 | 125 | central | 1/2 | invalidate |
| apps | 3 | 778 | central | 3/3 | invalidate + setQueryData |
| auth | 1 | 132 | central | 1/1 | setQueryData + invalidate |
| automatic-membership | 1 | 145 | central | 1/1 | invalidate |
| billing | 2 | 304 | central root + local scoped leaf (documented) | 1/2 | invalidate |
| board-sources | 1 | 231 | central | 1/1 | invalidate |
| boards | 1 | 165 | central | 1/1 | invalidate |
| browser-cloud | 1 | 183 | central | 0/1 | invalidate |
| calls | 4 | 349 | central | 4/4 | setQueryData (realtime patch) + invalidate |
| channels | 4 | 282 | central | 1/4 | setQueryData (list upsert) + invalidate |
| connections | 1 | 162 | central | 0/1 | invalidate |
| dashboards | 1 | 230 | central | 1/1 | invalidate |
| demonstrations | 1 | 77 | central | 0/1 | invalidate |
| designer | 3 | 629 | — (no query keys; composes agents/tools) | 2/3 | n/a |
| executors | 1 | 265 | central | 1/1 | invalidate |
| favorites | 1 | 77 | central | 0/1 | **optimistic** (onMutate/onError/onSettled) |
| feedback | 1 | 26 | central | 0/1 | invalidate |
| global-agents | 1 | 40 | central | 0/1 | setQueryData + invalidate |
| gmail | 1 | 170 | inline (`gmailKeys`) | 0/1 | invalidate |
| integrations | 3 | 497 | central | 3/3 | invalidate |
| iterations | 1 | 106 | central | 0/1 | invalidate |
| knowledge | 7 | 785 | central | 1/7 | invalidate |
| mail | 2 | 223 | inline (`connectedMailKeys`) | 2/2 | **optimistic** + setQueryData + invalidate |
| mailbox-connections | 1 | 122 | central | 0/1 | invalidate |
| messages | 1 | 185 | central | 0/1 | invalidate |
| notifications | 5 | 618 | central | 1/5 | invalidate |
| organization | 1 | 69 | central | 1/1 | invalidate |
| personal-assistant | 2 | 114 | central | 0/2 | setQueryData + invalidate |
| platform-push | 1 | 80 | central | 1/1 | invalidate |
| presence | 1 | 31 | central | 0/1 | invalidate |
| projects | 2 | 198 | central | 1/2 | setQueryData + invalidate |
| realtime | 2 | 219 | — (no query keys; SSE fan-out infra) | 0/2 | n/a |
| runs | 1 | 32 | central | 0/1 | invalidate |
| search | 1 | 215 | central | 0/1 | n/a (query-only) |
| secrets | 1 | 62 | central | 1/1 | invalidate |
| settings | 1 | 77 | inline (`scopedSettingKeys`) | 0/1 | invalidate |
| statuses | 1 | 164 | central | 0/1 | invalidate |
| subscriptions | 1 | 146 | inline (`subscriptionKeys`) + central (paginationKeys elsewhere) | 0/1 | invalidate |
| task-fields | 1 | 79 | central | 1/1 | invalidate |
| tasks | 1 | 240 | central | 0/1 | **optimistic** + setQueryData + invalidate |
| team | 4 | 283 | central | 1/4 | setQueryData + invalidate |
| threads | 10 | 2412 | central | 3/10 | setQueryData (streams) + invalidate |
| tool-grants | 1 | 232 | central | 1/1 | invalidate |
| tools | 1 | 13 | central | 0/1 | n/a (query-only) |
| triggers | 1 | 247 | central | 0/1 | invalidate |
| users | 4 | 384 | central | 3/4 | invalidate |
| voice | 9 | 1812 | central | 4/9 | n/a (mostly non-CRUD/streaming) |
| web-push | 1 | 35 | central | 0/1 | invalidate |
| workflows | 1 | 403 | central | 1/1 | invalidate |
