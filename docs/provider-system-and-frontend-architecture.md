# Provider System and Frontend Architecture

> Status: active target-state design.

## 1) Core rule

There are two different meanings of "provider" in this project.

They must not be conflated:

1. infrastructure/provider adapters
2. frontend/domain provider facades

If these get mixed together, the codebase will become hard to reason
about very quickly.

## 2) Infrastructure provider families

These are backend/runtime adapters chosen by deployment or config.

The detailed target-state design for inference/model providers lives in
[model-provider-connector-spec.md](./model-provider-connector-spec.md).
That document extends this one for the model-provider category only. It
does not change the frontend facade rules in this file.

Phase 1 required categories:

- auth provider
- model provider
- object storage provider
- queue/event provider
- observability provider

Later categories:

- secret encryption provider
- runtime secret store provider
- email provider
- semantic search/vector provider
- payment/billing provider
- remote execution provider

Rule:

- Phase 1 should allow one configured provider per category,
- provider selection must happen centrally in backend config,
- page-level or feature-level provider selection is not allowed.

Important clarification for later phases:

- the "one configured provider per category" rule remains true for most
  infrastructure categories.
- model providers are the exception once multi-provider inference is
  introduced.
- even then, raw provider selection still does not move into page-level
  or feature-level code.
- later-phase model routing must still be centrally defined in backend
  control-plane configuration as approved connectors and routing
  profiles.
- agents may reference an admin-defined routing profile, but they should
  not hold provider credentials or ad hoc provider-specific logic.
- the model-provider connector/orchestration system is a Phase 2
  backend/admin control-plane deliverable. Phase 1 may keep a
  single-route compatibility path so long as it does not block the later
  contract.
- `admin-only` for model-provider routing is a server-enforced policy
  boundary, not just a hidden picker option in `/admin`.

## 3) Frontend architecture rule

The frontend should be strictly componentized and reusable.

That means:

- no repeated avatar markup in three places,
- no repeated sidebar row markup,
- no repeated badge/status-pill markup,
- no page-local copies of entity cards, headers, forms, or list rows.

The HTML template should be broken into reusable primitives and composed upward.

## 4) Do not create a React Context provider for every entity

This is the key correction.

It is a bad architecture to create:

- `AgentProvider`
- `ProjectProvider`
- `ChannelProvider`
- `UserProvider`
- `ThreadProvider`

as separate React Context wrappers for the entire tree.

Why this is bad:

- too many nested providers,
- unclear ownership of data fetching,
- hard-to-debug rerenders,
- duplicated cache logic,
- provider composition hell.

## 5) Recommended architecture instead

Use three layers:

1. shared app providers
2. domain facades/services
3. reusable UI components

### 5.1 Shared app providers

These are the only top-level React providers Phase 1 should need in `/admin`:

- `AppProvider`
- `AuthSessionProvider`
- `ApiClientProvider`
- `QueryProvider`
- `ThemeProvider`

Optional later:

- `RealtimeProvider`
- `FeatureFlagsProvider`

These are app-wide concerns, not entity-specific concerns.

Phase 1 rules:

- `QueryProvider` means TanStack Query's `QueryClientProvider`
- do not build a custom query cache or a page-local fetch state system
  instead
- `ApiClientProvider` provides a typed fetch wrapper, not axios,
  configured with the JWT token from `AuthSessionProvider` and the base
  URL. Domain facades import the client from this provider through a
  `useApiClient()` hook.

### 5.1a UI stack

- **Tailwind CSS** for utility-first styling
- **shadcn/ui** for base primitive components such as Button, Input,
  Dialog, Tooltip, and ScrollArea
- custom components built on top of shadcn/ui primitives for
  domain-specific needs such as `ChannelRow`, `AgentRow`, and
  `StatusPill`
- **React Router v7** with `createBrowserRouter` for routing. Channel
  selection is URL state at `/admin/channels/:channelId`
- do not introduce a second CSS framework, CSS-in-JS library, or
  styled-components alongside Tailwind
- do not use a different component library such as MUI, Ant, or Chakra.
  shadcn/ui is the base

### 5.2 Domain facades/services

For each major entity, create one domain facade module, not one global React Context.

Examples:

- `agents`
- `projects`
- `team`
- `channels`
- `threads`
- `messages`
- `runs`
- `users`
- `tools`

Each domain facade owns:

- API calls
- request/response typing
- cache keys
- selectors
- mutations
- optimistic update rules where needed

The shape a facade actually takes, in this order:

1. **`hooks.ts` is the facade.** Fifty-odd of the fifty-seven directories under
   `admin/src/facades/` are exactly one `hooks.ts` holding the queries, the
   mutations and the types for that domain. That is the default, and a new
   facade starts there — not with five near-empty files.
2. **Split by sub-resource when it grows**, never into layer-shaped shards.
   `facades/knowledge/` splits into `file-hooks.ts`, `comment-hooks.ts`,
   `backlinks-hooks.ts`, `wikilink-hooks.ts`; `facades/team/` into
   `invitations.ts`, `provisioning.ts`, `host-sync.ts`. Splitting a small
   facade into `api.ts`/`queries.ts`/`mutations.ts` scatters one resource over
   four files and is the shape to avoid.
3. **`keys.ts` per facade.** A facade's query keys belong to the facade that
   reads and invalidates them (`facades/agent-todos/keys.ts` is the pattern).
   Until every domain has moved, the keys live centrally in
   `admin/src/lib/query-keys.ts`, which `admin/test/query-key-invariants.test.ts`
   pins — the key families move directory by directory, and no key is ever
   written as a raw literal at a call site either way.
4. **Non-React domain logic belongs to the facade, not to the component that
   calls it.** `facades/apps/connect-flow.ts`, `facades/designer/types.ts` and
   `facades/tools/deep-water-tool-filter.ts` are facade files with no React in
   them. A facade never imports from `components/`, `layouts/` or `pages/` —
   see §5.4.

This gives you an "agent provider facade" in practice without turning it
into a tree-wide React Context.

### 5.3 Reusable UI component layers

The UI is split into:

1. primitives — no data dependencies at all
2. composed shared components — may read facade hooks and providers
3. feature components — one product domain each
4. layouts — the shell and the app chrome around the router
5. page shells — one routed screen each, holding composition and nothing else

The structure under `admin/src`:

```text
lib/            pure modules: formatting, storage, the API client, native-shell probes
hooks/          generic React hooks with no provider or facade dependency
navigation/     the one navigation framework: surfaces, back, motion, layout, doorways
facades/        one directory per domain (§5.2)
providers/      the app-wide React contexts, and only those
bridges/        render-nothing components that wire an outside system in
                (the native shell, desktop updates, notification centre)
components/
  primitives/   Avatar, Badge, Pill, Switch, TabBar, Notice, Skeleton, …
  overlays/     the overlay machinery: Sheet, Popover, OverlayCard, useOverlay
  shared/       ScreenHeader, Card, ChoiceGroup, AgentRow, IncomingCallDialog, …
  features/     channels/ agents/ projects/ knowledge/ settings/ triggers/ …
layouts/        RootLayout, AdminShellLayout, DesktopWindowFrame, admin-shell/*
pages/          one directory per routed page: <Page>.tsx plus its own sub-views
```

Two rules the tree does not state on its own:

- **`pages/<page>/` holds single-consumer composition only.** A file under a
  page directory has exactly one importer: that page (or a sub-view chain
  ending at it). The moment a second surface wants it, it moves down to
  `components/features/<domain>/` — a page directory is a shell, never a
  library.
- **A component that needs a provider is not a primitive.** `AgentAvatar` and
  `UserAvatar` live in `shared/` precisely because they read the identity and
  presence providers; a primitive stays renderable in isolation.

### 5.4 Dependency direction

`admin/src` is ten ordered layers, and an import may only run downward. An
arrow is "may import from"; a layer may always import from itself, from
`node_modules`, and from the `@nessie/*` workspace packages.

```text
lib                    →  (nothing else in admin/src)
hooks                  →  lib
navigation             →  lib, hooks, providers
facades                →  lib, hooks, providers
providers / bridges    →  lib, hooks, facades, navigation, components/overlays¹
components/primitives  →  lib
components/overlays    →  lib, hooks, navigation, components/primitives
components/shared      →  lib, hooks, navigation, facades, providers,
                          components/primitives, components/overlays
components/features    →  everything above, + components/shared
layouts                →  everything above
pages                  →  everything above, + layouts
router.tsx / main.tsx  →  everything
```

¹ `providers → components/overlays` is for **viewport mounts only** — a
provider that mounts the region an ambient surface lives in
(`ToastProvider` → `CardViewport`). It does not license a provider rendering
product UI.

`components/shared` may read facade **hooks** and providers, never a facade's
`api.ts`: a shared component that took identity as a prop would push identity
plumbing through every call site, which §6 forbids.

`scripts/lint-admin-layers.mjs` enforces this on every `pnpm lint`. It resolves
each relative specifier against the importing file's real path, classifies both
ends by longest-prefix match, and fails on an upward edge. Two escapes exist,
both narrow and both carrying their reason in the script: an `EXCEPTIONS` entry
for a named file (`navigation/prewarm.ts` must call the destination's exact
`fetch*`), and a shrinking `ALLOWLIST` of individual edges. The allowlist
self-checks — an entry whose edge no longer exists fails the gate until the
line is deleted — so it can only shrink. Inverting the dependency (moving the
shared symbol down) is always the fix; adding a line is the admission that the
move is not available yet.

## 6) Single source of truth rules

### 6.1 Identity/session

There must be one source of truth for:

- current user
- current session
- current org/project/team bootstrap context

That source is:

- backend auth/session contract,
- consumed by `AuthSessionProvider`,
- exposed through shared hooks.

Never:

- instantiate auth helper classes separately per page,
- reconstruct current user from multiple endpoints,
- keep duplicate local identity stores.

### 6.2 Domain data

There must be one canonical cache path per entity family.

Example:

- agents come from one agent data facade,
- channels come from one channel data facade,
- projects come from one project data facade.
- tools come from one tool data facade.

Never:

- fetch agents one way in sidebar and another way in detail pages with
  separate hand-rolled state,
- duplicate mapping/transforms in three components,
- keep hidden parallel stores for the same records.

## 7) Phase 1 provider/facade set

Phase 1 should implement these frontend facades:

- `auth`
- `channels`
- `agents`
- `tools`
- `threads`
- `messages`
- `runs`

Phase 1 should not need frontend facades yet for:

- secrets
- token ledger
- translation settings
- remote workers
- workflow builder

Later-phase admin facades for the model-provider control plane should be:

- `inferenceProviders`
- `inferenceCredentialBindings`
- `inferenceModels`
- `inferenceCapabilityOverrides`
- `routingProfiles`
- `toolMediators`
- `inferenceEvals`
- `inferenceEvalRuns`
- `tokenLedger`

These are admin/backend control-plane surfaces. They are not part of the
standard user-facing Phase 1 facade set.

## 8) Template-to-component mapping

From the current template, at minimum extract:

- `Avatar`
- `PresenceDot`
- `RailButton`
- `SidebarSection`
- `ChannelRow`
- `AgentRow`
- `ToolRow`
- `UnreadBadge`
- `PageHeader`
- `Composer`
- `MessageBubble`
- `StatusPill`

Tool-specific reusable components should also exist once tools appear in
`/admin`:

- `ToolBadge`
- `ToolTransportPill`
- `ToolPermissionPill`
- `ToolCategoryIcon`

This is mandatory. Do not leave these as repeated page-local fragments.

## 9) Agent activity observability (mandatory Phase 1 UI)

This is a first-class product requirement, not an afterthought. The
biggest failure mode of agent platforms is that users cannot see what is
happening. Nessie must make agent activity visible at all times.

### 9.1 Agent activity panel

The `/admin` UI must always show an agent activity panel when agents
exist. This panel is visible regardless of which page the user is on.

Required content:

- list of all agents the user has access to in the current scope,
  channel or organization
- each agent row shows:
  - agent name and role
  - current status indicator: `idle` (dim dot), `thinking` (pulsing
    dot), `executing` (animated dot), `waiting_approval` (amber dot),
    `error` (red dot)
  - if active: what the agent is currently doing (tool name, short description)
  - last activity timestamp

Status indicators must update via WebSocket in real time. There is no
polling. If the WebSocket disconnects, the UI must show a
connection-lost state, not stale green dots.

### 9.2 Agent drill-down view

Clicking on any agent in the activity panel opens a detail view showing:

- **Current activity:** what the agent is doing right now, including
  tool name and sanitized input/output preview
- **Sub-agent tree:** if this agent has spawned sub-agents, show them
  as a nested list with the same status indicators. Clicking a
  sub-agent opens its own drill-down
- **Tool execution log:** chronological list of tool calls for the
  current or most recent run, each showing tool name, duration,
  success/failure, and truncated output preview
- **Thought process (Phase 2+):** opt-in stream of agent reasoning
  previews. In Phase 1, this section of the drill-down shows a
  placeholder, "reasoning trace available in a future release". The
  `agent.thought` event is not emitted in Phase 1
- **Last 5 messages:** the five most recent messages this agent has sent
  or received, always visible without scrolling or navigation. This is
  a hard requirement, not "load on demand" but always present in the
  agent detail view

The drill-down view must work for sub-agents at any depth. If agent A
spawned agent B which spawned agent C, clicking through A -> B -> C
must show C's activity, tools, and messages.

### 9.3 Required frontend data for agent activity

The agent Activity page and drill-down require these data flows. Activity is
owned by the Agents navigation surface; it does not appear as a duplicate
section in the chat sidebar.

- **WebSocket subscription** to the `WsEventMap` from
  [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
  section 4, specifically: `agent.status`, `agent.tool.start`,
  `agent.tool.end`, `agent.spawned`, `message.new`, and `run.updated`.
  Do not subscribe to SSE events on the WebSocket
- **Agent facade query:** `useAgents()` for the agent list with status,
  scoped to current channel or organization
- **Agent detail query:** `useAgentActivity(agentId)` for tool log,
  sub-agent tree, and thought stream
- **Agent messages query:** `useAgentMessages(agentId, { limit: 5 })`
  for the always-visible last 5 messages

These must follow the domain facade pattern from section 5.2. Agent
activity is not a separate React Context provider. It is part of the
`agents` facade with WebSocket-driven cache updates.

Cache update rules:

- WebSocket `agent.status` events update the agent list cache in place.
  No refetch
- WebSocket `agent.tool.start/end` events update the agent detail cache
  in place
- WebSocket `agent.spawned` events update the sub-agent tree in the
  agent detail cache
- sub-agent tree is populated on initial load and on WebSocket
  reconnect via REST, `GET /api/agents/{agentId}/children`, then kept
  live via `agent.spawned` events
- the last-5-messages query is a standard paginated query that also
  receives WebSocket-driven invalidation when a new message arrives for
  that agent

### 9.4 Required `/admin` components for agent activity

Add to the mandatory component list:

- `AgentActivityPanel` — the Activity-page agent list with status dots
- `AgentStatusDot` — the animated status indicator:
  idle/thinking/executing/waiting/error
- `AgentDetailDrawer` — the drill-down view opened by clicking an agent
- `SubAgentTree` — nested sub-agent list with recursive drill-down
- `ToolExecutionLog` — chronological tool call list with duration and status
- `AgentThoughtStream` — Phase 1 stub with placeholder; wired to
  `agent.thought` event in Phase 2
- `AgentMessagePreview` — the always-visible last-5-messages list

These are feature components under `components/features/agents/` and
must not be built as page-local fragments.

## 10) Architectural judgment

So the answer to your question is:

- yes, every major entity should be encapsulated behind a provider-like facade,
- no, that should not usually mean a React Context provider per entity.

The right model is:

- a small number of top-level app providers,
- many domain facades/hooks,
- reusable component primitives,
- one canonical identity/session provider.

## 11) Cross-links

- [implementation-phases.md](./implementation-phases.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md)
- [functionality.md](./functionality.md)
- [model-provider-connector-spec.md](./model-provider-connector-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
