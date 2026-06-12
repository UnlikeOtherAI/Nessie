# Slack-Parity Implementation Plan

Status: proposed — 2026-05-30
Source: 10-agent gap discovery (`docs/research` not yet captured; synthesis in session)

## Goal

Close the human-collaboration gaps that make Nessie usable as a day-to-day Slack
replacement, while deliberately **not** rebuilding the parts the agent model already
covers (bots, app directory, slash commands, outbound webhooks, pull-style
integrations). Each phase is independently shippable. Worktree-per-task is mandatory.

## Guardrails

- **Do not build:** Slack-style bot framework / app manifest / app directory /
  third-party OAuth install flow / slash-command registry. `AgentBinding` already
  *is* the bot. Most "missing integrations" are agents fetching on demand.
- **The one inbound carve-out that is real:** webhooks / event subscriptions coming
  *from* external systems (GitHub/Jira/Stripe). Covered in Phase 7.
- Minimum complexity. No premature abstraction. Each schema change is additive
  (nullable columns / new tables); no destructive migrations.
- Every phase: migration + `prisma:migrate:deploy`, rebuild worker/admin where
  touched, kelpie-verify any UI, update `docs/functionality.md` for contract changes.

## Current foundations (already present — build on these)

- Messaging spine: `Channel` / `ChannelMember` / `Thread` / `Message` /
  `MessageReaction` / `ThreadReadState` (`api/prisma/schema.prisma:613-730`).
- Realtime hub: `api/src/realtime/hub.ts`; `WsEventSchema` union of 11 events
  (`packages/schemas/src/index.ts:486-551`). Adding events = extend this union.
- Storage layer configured but unwired: `packages/config` `StorageProviderSchema`
  (filesystem/gcs/s3) + `packages/runtime/src/gcs-storage.ts`.
- RBAC schema present but unenforced: `PolicyRule` / `PolicyBinding`
  (`schema.prisma:1675-1705`) + `POST /api/policy/check`.
- Semantic memory search: `packages/memory` `match_thoughts` + `/api/thoughts/search`.
- Calls: `Call` / `CallParticipant` (`schema.prisma:2053`) via Jitsi.

---

## Phase 1 — Message lifecycle & discovery
Highest daily-use value; sits on existing infra.

### 1a. Message edit & delete  *(S–M)*
- Schema: add `editedAt DateTime?`, `deletedAt DateTime?` to `Message`.
- API: `PATCH /api/threads/:threadId/messages/:messageId` (author-only; sets
  content + `editedAt`); `DELETE …` (soft delete; author or channel-manager).
- Realtime: new `message.updated` and `message.deleted` events in `WsEventSchema`.
- Admin: edit-in-place + delete affordance in `ChannelsPage.tsx` message rows.
- List path: `listThreadMessages` filters `deletedAt`, returns tombstone for deleted.

### 1b. Human & broadcast mentions  *(M)*
- Extend mention parser in `api/src/services/messages.ts` (currently agent-only):
  resolve `@user` against channel members, plus literal `@here` / `@channel` /
  `@everyone`.
- Persist parsed mentions on `Message.metadata.mentions` (userIds + broadcast flags).
- Drives notification routing in Phase 2 (delivery filter respects mentions).

### 1c. Message search  *(M)*  — also an agent-native win (Phase 9)
- Postgres FTS: add `tsvector` generated column + GIN index on `Message.content`
  (migration-only; no model field churn beyond an `Unsupported` column or raw SQL).
- API: `GET /api/messages/search` (org-scoped) and
  `GET /api/channels/:channelId/messages/search`, supporting `q`, `from:` (senderId),
  `before:`/`after:` (date range), `channelId`.
- Add `senderId` + date-range filters to `listThreadMessages` first (the quick-win
  half — unblocks `from:`/jump-to-date even before FTS lands).
- Admin: search bar in channel header → results list with jump-to-message.

### 1d. Message permalinks  *(S, low priority)*
- Deterministic route `/c/:channelId/t/:threadId/m/:messageId`; "Copy link" action.

---

## Phase 2 — Real-time human signals & delivery
Realtime hub exists; most of this is new event types + preference fields.

### 2a. Presence  *(M)*
- Schema: `User.lastSeenAt DateTime?` (or ephemeral in hub memory — prefer in-memory
  presence map in `hub.ts`, persisted `lastSeenAt` only on disconnect).
- Hub: client heartbeat ping; derive online/away/offline.
- Realtime: `presence.updated` event. Wire `PresenceDot.tsx` (currently a stub).

### 2b. Typing indicators  *(S)*
- Realtime-only: `typing.start` / `typing.stop` events; no persistence.

### 2c. Notification preferences + per-channel mute  *(M)*
- Schema: extend `User.preferences` (JSON) with `notifications` block
  (global `all|mentions|nothing`, DND/quiet-hours window); add
  `ChannelMember.notifyLevel` (`all|mentions|nothing`) + `mutedUntil DateTime?`.
- Delivery: `message.new` fan-out in `api/src/index.ts` must consult prefs + mute +
  Phase 1b mentions before pushing to each subscriber. **This is the core change** —
  today it broadcasts unconditionally.
- API: `PATCH /api/auth/me/preferences` (extend), `PATCH /api/channels/:id/notify`.
- Admin: per-channel mute/notify menu; global notification settings page.

### 2d. Push notifications (offline)  *(L)*
- Schema: new `DeviceToken` model (userId, platform, token, createdAt).
- Integrate Web Push (VAPID) first (browser/admin), then APNS/FCM for the mobile
  companion. Deliver on `message.new`/mention/`call.started` when recipient offline.
- Gated behind config; no-op if unconfigured (no hard dependency).

---

## Phase 3 — Files & media
Storage layer already configured — this is wiring, not new infra.

### 3a. Upload/download + attachments  *(M)*
- Schema: new `Attachment` model (id, organizationId, uploaderId, messageId?, kind,
  mime, sizeBytes, storageKey, width?, height?, createdAt).
- Storage adapter interface in `packages/runtime` covering filesystem/gcs/s3
  (gcs already implemented; add filesystem + s3 to match config options).
- API: `POST /api/uploads` (multipart → storage → Attachment row),
  `GET /api/attachments/:id` (signed/streamed download with member auth),
  attach `attachmentIds[]` on `CreateThreadMessageBodySchema`.
- Admin: enable the disabled "Send as file" button in `OversizePasteDialog.tsx`;
  add drag-drop + clipboard-image paste in the composer.

### 3b. Inline previews  *(M)*
- Render image/video inline; PDF preview; code-snippet block with syntax highlight.
- `Message.metadata` already JSON — store render hints; no schema churn.

---

## Phase 4 — Channel lifecycle & metadata
Basic org hygiene; none of it agent-coverable.

- Schema: add `topic String?`, `description String?`, `archivedAt DateTime?` to
  `Channel`; add `role` to `ChannelMember` (`manager|member`) for per-channel admin.
- API: `PATCH /api/channels/:id` (rename/topic/description; manager-gated),
  `POST /api/channels/:id/archive` + `/unarchive`, `DELETE /api/channels/:id`
  (soft), `POST /api/channels/:id/join` (**self-join for `visibility=public`** —
  today blocked by `getChannelIfMember`).
- Server-side slug validation in `createChannelForUser` (mirror admin `toSlug`).
- Admin: channel settings panel; browse-and-join directory.
- Defer: default-channels auto-membership; cross-team shared channels (low impact).

---

## Phase 5 — Governance & onboarding
Security-critical: the policy engine is currently scaffolding only.

### 5a. Enforce RBAC  *(L — highest-risk, do carefully)*
- Build a single `authorize(actor, resourceType, action, scope)` helper that
  evaluates `PolicyRule`/`PolicyBinding` with deny-overrides (the
  `/api/policy/check` logic exists — extract + reuse).
- Thread it through request handlers, tool execution, channel routing, and agent
  binding. Today only the `owner` role is checked. Roll out per-resource-type with
  tests; do not flip everything at once.

### 5b. Invite flow  *(M)*
- Schema: new `InviteToken` model (org/project/team scope, email?, role, token,
  expiresAt, acceptedAt).
- API: `POST /api/invites`, `POST /api/invites/:token/accept`, list/revoke.
- Admin: invite screen; accept landing page.

### 5c. Compliance (defer unless required)  *(L)*
- Retention policy (message TTL job), eDiscovery export, legal hold, SCIM, IP
  allowlists. Build only when a hosting customer needs it.

---

## Phase 6 — Authoring surfaces
User-facing no-code UIs over engines that already work.

- **Visual workflow builder** *(L)*: drag-drop canvas + node toolbox + properties
  panel in `WorkflowDesignerPage.tsx` (engine + REST already exist; users currently
  hand-write JSON graphs). See existing `docs/plans/2026-04-07-workflow-builder.md`
  and `…-n8n-inspired-workflow-tools-and-triggers.md` — align, don't duplicate.
- **Lists / Kanban board** *(M)*: board view over the existing `Task` model + status
  enum.
- **Canvas (collaborative docs)** *(L, defer)*.

---

## Phase 7 — Inbound integration hardening
The legitimate inbound side agents don't cover.

- HMAC-SHA256 signature verification on the inbound webhook endpoint (today
  bearer-key only)  *(S)*.
- Delivery retry/backoff: add `retryCount`, `nextRetryAt` to `AgentTriggerDelivery`;
  worker retries with backoff  *(S–M)*.

---

## Phase 8 — Productivity UX  *(mostly S, additive)*
Pin messages; bookmarks / save-for-later (`User.preferences`); drafts; scheduled
send; reminders (lean on agent scheduling). Pick off opportunistically alongside
larger phases.

- **Custom status with schedules** *(implemented 2026-06-10)*: `/settings/statuses`
  lets users create emoji-backed statuses, set one active manually, attach weekly
  or date-range schedules, and persist response-agent instructions plus
  channel/project-specific contact rules.
- **Remaining status automation**: inbound message dispatch still needs to
  evaluate active contact rules and start the configured response agent with the
  stored instructions.
- **Global top bar (implemented 2026-06-12)**: Slack-style chrome above the rail
  and content (`admin/src/layouts/admin-shell/TopBar.tsx`) — back/forward history,
  a recent-channels menu, a centered **command-palette search** (inline grouped
  results across channels/people/projects/messages/knowledge, reusing
  `useGlobalSearch`; `⌘K`/`Ctrl-K` to focus), a workspace badge, and a help
  shortcut. Shared across web, the iPad WebView shell (clears the status bar via
  `env(safe-area-inset-top)`), and the Tauri desktop app, where it doubles as the
  window title bar (traffic-light gap + drag region).
- **Chat author identity (implemented 2026-06-12)**: thread messages now embed the
  real `author` (`displayName` + avatar sources), so every message renders the
  actual sender's name and avatar via `UserAvatar` (profile picture when one
  resolves — uploaded attachment > provider > Gravatar — else initials) instead of
  always showing the viewer's name on a generic gradient. `ThreadMessageRecord`
  gained an optional `author` field.

---

## Phase 9 — Agent-native differentiators (beat Slack, not just match)
- Agent-generated **link unfurls**: agent fetches URL → posts live context summary
  (richer than static OpenGraph).
- Surface **semantic/hybrid memory search** as first-class message search (highest
  leverage — turns the Phase 1c parity gap into a differentiator).
- **Auto meeting notes**: agent transcribes Jitsi call → posts action items to thread.
- **Agents-as-routers**: wire `MessageReaction` / `message.created` into event
  triggers so an agent watches a channel and routes/summarizes/escalates.

---

## Suggested sequencing

1. **Quick wins** (S, parallelizable): 1a delete, 1c sender/date filters, 2b typing,
   4 self-join public, 7 HMAC, 8 pin/bookmark.
2. **Three M pillars in parallel:** Phase 3 (file upload), Phase 1c (full-text +
   surface memory search), Phase 2a+2c (presence + notification prefs).
3. **Then:** Phase 1b mentions (feeds 2c delivery), Phase 4 channel lifecycle.
4. **Large follow-ons:** 2d push, 5a RBAC enforcement, Phase 6 builder.
5. **Layer in** Phase 9 agent-native wins opportunistically once the spine is solid.

## Definition of done (per phase)

- Migration applied via `pnpm --filter @nessie/api prisma:migrate:deploy`.
- Worker rebuilt (`pnpm --filter @nessie/worker build`) if worker touched; admin
  rebuilt + kelpie-verified at `http://localhost:5555` if UI touched.
- `docs/functionality.md` updated for any contract change; this plan checked off.
- Lint + tests green. Merge to `main` from worktree, then clean up the worktree.
