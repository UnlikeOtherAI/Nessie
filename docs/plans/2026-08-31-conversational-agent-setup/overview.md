# Conversational agent setup: apps, Gmail and local execution

Date: 2026-08-31

Review: Kimix code-aware review completed 2026-09-01; findings incorporated

Status: implementation-ready plan; no implementation claimed

## Table of Contents

- [Core decisions](core-decisions.md)
- [Contracts and invariants](contracts-and-invariants.md)
- [Delivery and verification](delivery-and-verification.md)

## Outcome

One natural-language instruction is enough to shape a new agent and expose the
next real setup decision in its conversation. The agent may name and describe
itself, request an external app, or recognise the signed Mac app as its local
executor, but it never turns model output into hidden authority. The person gets
one clear, in-context action wherever a consequential decision is still needed;
after that action, Nessie returns to the same card and continues automatically.

This plan covers three launch scenarios:

1. **Create and shape an agent in one prompt.** A person clicks **New agent**,
   describes the job once, sees the inferred name, role and behaviour applied
   to the same draft, and clicks **Create _Name_**. Nessie creates the agent and
   its private home atomically, opens that conversation, and carries the
   original instruction forward. A newly created private agent may also propose
   its own rename or role change from its owner’s interactive setup turn; it
   cannot change instructions, ownership, visibility, grants, bindings or
   automation.
2. **Connect a service in chat.** The agent recognises that the work needs an
   external app, offers real catalogue choices, opens provider sign-in, returns
   to the same card, verifies the exact agent grant, and continues. Gmail is a
   release-blocking first-party example, not a future generic-app demo.
3. **Use this Mac.** In the signed Developer ID Mac app, a coding agent sees
   that the packaged executor companion is present and offers one setup card.
   Native workspace selection, fingerprint/policy review and daemon start stay
   explicit, but the user never installs a second CLI or copies a pairing token.
   The current Windows desktop shell has no supported executor companion, so
   Windows execution is deliberately parked until its platform sandbox,
   packaging, signing and local-policy implementation exist.

The app-connection exchange is:

1. A person asks an agent to do work that needs an app, such as watching Linear
   issues.
2. The model judges that an app is needed and searches Nessie's existing Apps
   catalogue. No keyword or service-name matcher drives this decision.
3. The agent posts an in-chat card with server-resolved choices, publisher and
   trust information, capability count when known, and the exact agent/scope
   that would receive access.
4. The person selects an app. That authenticated click, not the model call, is
   the authority to create or reuse the connection.
5. Nessie opens the existing provider OAuth flow in a popup/system browser. The
   provider returns to Nessie's existing constant callback page; no caller
   controls a return URL.
6. On return or refocus, the card reads the live connection. If the consent
   covered a known capability set, Nessie grants exactly that set to the target
   agent. If capabilities were not known before sign-in, the card shows the
   discovered set and asks for one explicit **Allow this agent** confirmation.
7. When the connection is active and the explicit grant has landed, Nessie
   creates one hidden, server-authored kickoff in the same thread. A fresh run
   rebuilds the toolset, sees the newly projected MCP tools, and continues the
   original request without asking the person to type “done”.

The user-facing words are **Apps**, **Connect**, **Sign in**, and
**Capabilities**. MCP, OAuth, PKCE, registry entries, instances, projections,
and credential overrides remain implementation terms.

## What already exists

Most of the security-sensitive work is already implemented and must be reused:

- Agent Designer already has a model-driven `Design Assistant` whose structured
  calls fill name, role, model, system prompt and tool choices in the same form;
  the person still owns the single **Create agent** mutation
  (`admin/src/pages/AgentDesignerPage.tsx`,
  `admin/src/facades/designer/hooks.ts`,
  `admin/src/components/features/agents/designer/useAgentDesigner.ts`). The PA’s
  `agent_create` also proves chat provisioning can call the same
  `createAgentRecord` service and route-level validation. There is intentionally
  no general runtime `agent_update` tool today.
- `/apps` and `/apps/:slug` are the owning catalogue and management surfaces.
  They are projections of `McpCatalogEntry`, not a second catalogue
  (`docs/plans/2026-08-29-apps-catalogue/overview.md`).
- `POST /api/apps/:slug/connect` already orchestrates `createInstance` → probe
  → `startOAuth`, adopts an existing instance instead of colliding with it, and
  returns `connected`, `authorize`, or `needs_secret`
  (`packages/mcp-manage/src/apps/app-connect.ts`,
  `api/src/routes/apps-connect.ts`).
- Dynamic and static MCP OAuth already use one-shot Postgres state, encrypted
  token storage, refresh, a fixed callback page, server-owned origins and
  IP-pinned egress. Static flows require PKCE; dynamic flows currently use S256
  only when advertised, and several attempt/denial/refresh lifecycle gaps listed
  below must close before chat launch
  (`packages/mcp-manage/src/mcp-oauth*.ts`,
  `api/src/routes/mcp/oauth.ts`).
- `useAppConnectFlow` already handles popup blocking, focus/visibility return,
  status polling, reload markers, expiry, and retry. `AppConnectDialog` and
  `ConnectProgress` already render the Apps flow
  (`admin/src/facades/apps/connect-hooks.ts`,
  `admin/src/components/features/apps/`).
- App-installed protected tool projections carry `requiresExplicitGrant`, and
  the worker honours a direct agent `ToolGrant` whose descriptor fingerprint is
  current. A capability receives that persisted default grant for the
  system-managed Personal Assistant when it first appears; a disabled grant is
  a durable tombstone, so a reprobe never restores it. Shared agents remain
  explicitly opt-in. Core decision 5 makes that existing `ToolGrant` model the
  one authority for descriptor-version consent and every management surface.
- The Personal Assistant already has powerful `connector_*` management tools,
  and `comms_connect_card` proves a tool can put an interactive account card in
  a thread. Those are useful precedents, but neither is the general-agent
  contract described here.
- Hidden `system` messages already start scheduled runs without rendering in
  the feed or entering later conversation history. They provide the clean
  continuation mechanism after a connection becomes ready
  (`api/src/services/trigger-dispatch.ts`,
  `worker/src/control/trigger-run.ts`, `worker/src/run/execute/prompt.ts`).
- Gmail already has a first-party per-user communications connection, PKCE
  Google OAuth, encrypted credentials, initial/incremental sync, resource
  selection, revocation and `needs_reauthorization` state
  (`api/src/routes/comms-connections.ts`, `packages/comms-google/`,
  `packages/workspace-admin/src/comms-credential-coordinator.ts`). Its current
  chat card is PA-only, returns OAuth to `/settings/connections`, and the runtime
  exposes no Gmail search/read/draft tools. Its OAuth requests
  `gmail.readonly`; therefore the screenshot’s “Search, read, draft, and manage
  email” promise is not implemented yet and must not be copied as marketing
  text until the corresponding tools and least-privilege scopes exist.
- The direct Developer ID Nessie Desktop build already bundles the executor CLI
  and exact Node runtime, verifies hashes and the signed macOS app,
  restricts IPC to approved Nessie origins, uses native workspace selection and
  confirmations, and supervises the daemon
  (`desktop/scripts/prepare-executor-runtime.mjs`,
  `desktop/src-tauri/src/executor_companion.rs`,
  `desktop/src-tauri/src/executor_companion/runtime.rs`). The current management
  doorway is the Executors page. Production companion controls intentionally
  reject every non-macOS platform, and the Mac App Store build deliberately
  excludes the executor runtime; only the signed Developer ID distribution is
  executor-capable.

The missing product layer is one conversational setup grammar across agent
creation, app authorization and local execution. The missing security layer is
provenance for data returned by a personal connector plus explicit boundaries
between profile shaping, account authorization, tool grants and host execution.

## Home and doorways

| Question | Owning surface | In-context doorway |
| --- | --- | --- |
| What will this new agent be called and how will it behave? | Existing Agent detail → Edit / Agent Designer | Chat-first **New agent** draft and the new agent’s bounded setup turn |
| Which apps exist and which account is connected? | `/apps` and `/apps/:slug` | The agent's app-choice card links to the selected app detail. |
| May this agent request app setup? | The existing Agent Tools configuration | An explicit **Request app connections** capability enabled when creating/editing the agent. |
| Does this person consent to connect? | The provider-neutral chat request | The **Connect _App_** button in the thread where the need arose. |
| May this agent use the app's capabilities? | App **Agents with access** / Agent Tools, backed by canonical explicit `ToolGrant` rows after migration | The same card names the agent and scope before consent, or shows **Allow this agent** after discovery. |
| How is a broken/expired connection repaired? | `/apps/:slug` connection management | The stale in-chat card and a durable alert both lead to **Reconnect**. |
| Which machine and workspace may the agent use? | Existing `/executors/:id` detail and review surfaces | A local-executor setup/status card in the coding agent’s private home |
| May this organization use the early-access journey? | `/settings/organization#early-access` → **Conversational agent setup** | The disabled New-agent/card action links an owner to that setting; members see that an owner must enable it. |

There is no new Plugins page, connector catalogue, credential screen, or grant
table. Chat is a doorway into the Apps capability; `/apps` remains its home.
Likewise there is no second Agent Designer or executor control plane: the
conversation is a compact doorway into the same draft/create services and the
same executor pairing, revision-review and operation-grant services.

## Product boundaries

### In scope

- A chat-first Agent Designer path turns one description into a structured draft
  and one clearly labelled create action, then lands in the agent’s real private
  home rather than back at an agent list.
- A newly created, owner-private agent can propose a change only to its own name
  and role during an interactive setup turn through a narrow shared profile
  service. This is not a general-purpose `agent_update` tool; its behavioural
  instructions remain editable only through the existing Agent Designer.
- Agents explicitly granted the presentation capability can search the
  entitlement-scoped Apps catalogue and request a connection during a live
  human turn.
- One or several catalogue choices can be offered.
- OAuth, no-auth, and API-key apps share one card state machine. API keys use
  the existing secure secret dialog and are never requested in ordinary chat.
- A successful connection can grant the current projected capabilities to the
  target agent and automatically continue the original task.
- Reload, popup cancellation, duplicate clicks, another open tab, revoked
  membership, stale cards, hidden/locked apps, and a busy agent/thread slot are
  handled deliberately.
- Personal connector results acquire a disclosure basis before the model sees
  them.
- Recurring agents get an explicit reauthorization signal if their credential
  later stops working.
- Gmail ships as an end-to-end launch fixture: connect, return to the same card,
  select mailbox resources, search/read, create a draft, separately confirm any
  send, revoke, reauthorize, and continue the originating task.
- The signed Developer ID Mac app can pair/start its packaged basic executor
  from a conversation card and bind an exact reviewed operation set to the
  owner’s private agent; the direct build gains the missing signed guest pack
  before it advertises managed Codex as zero-install.

### Not in scope

- A normal run may not rewrite its own system prompt, model, tool policy,
  ownership, visibility, channel bindings, triggers, run limits or executor
  grants. The creation/setup seam is structurally bounded and expires.
- A model may not silently install an app, choose a credential owner, widen an
  install scope, grant itself tools, or follow an arbitrary authorization URL.
- The PA-only `connector_install`, `connector_authorize`,
  `connector_set_secret`, and `connector_uninstall` mutation tools are removed
  from the PA toolset in the same rollout that enables the card/Apps-management
  path. None becomes available to ordinary/shared agents, and the unsafe PA
  mutations and the new journey are never live together.
- This work does not create schedules merely because an agent says “I will
  watch”. Recurrence continues to use the existing Agent Triggers surface (or
  the PA's existing trigger-creation route mirror). An agent with no active
  trigger must not claim that a background watch is running.
- Communications providers such as Gmail/Slack keep their current connector
  adapters and routes. The chat card may reuse their presentation primitives,
  but this plan does not migrate communications data into MCP.
- No provider login is embedded in an iframe and no password is handled by
  Nessie.
- No raw shell or host filesystem is exposed to the model. The desktop card
  still creates a reviewed executor binding and uses the executor’s sandbox/COW
  operation contracts.
- The Mac App Store build remains sandboxed and executor-free. This plan does
  not smuggle the companion into that distribution.
- Windows executor support is not claimed from the existence of a Tauri Windows
  bundle. It remains parked until a Windows-native companion passes the same
  packaging, integrity, path isolation, daemon-lifecycle and local-policy bar.
