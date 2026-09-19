# What exists today

## What exists today (verified 2026-09-17)

Kept because every decision below answers one of these facts.

- **The agent row is already mostly data.** `model Agent`
  (`api/prisma/schema.prisma:2871`) carries `name`, `role`, `visibility`, `effort`,
  `systemPrompt`, `toolPolicy` (sparse key → boolean), `runLimits`, `todosEnabled`,
  `voiceName`, `speakingStyle`, `provider`/`model`/`modelSubscriptionId`,
  `avatarAttachmentId`/`avatarBackgroundColor`. Six columns are server-set and have no
  write path a client can reach: `agentKind`, `systemManaged`/`systemSlug`,
  `surfacePolicy`, `delegationMode`, `executionMode`, `routingProfileId`
  (`api/src/contracts/agents.ts` → `CreateAgentBodySchema` accepts none of them).
- **Instructions live in documents, not the column.** Once
  `AgentCoreDocumentMigration` has a row for the agent, `readCanonicalAgentCore`
  (`packages/knowledge/src/agent-core-write.ts:96`) reads the published `identity`
  and `working_rules` pages from `AgentCoreDocument` and the column is retired. The
  clone route already goes through this read. Every other agent document — knowledge,
  templates, examples, procedures, experiences (`KnowledgeDocumentRole`,
  `schema.prisma:609`) — is a `KnowledgePage` in the agent's `<Agent> — Documents`
  home (`KnowledgeSpace.ownerAgentId`, provisioned by
  `packages/knowledge/src/provisioning.ts`), with an immutable published
  `KnowledgePageVersion` carrying `trust`, `origin` (which already has `import`),
  `sourceContentHash`, and for file pages an `attachmentId` whose bytes are the
  authority.
- **Every document version carries a disclosure basis.** `KnowledgePageVersionBasisScope`
  and `KnowledgePageVersionDisclosureSource` (`schema.prisma:6057`, `:6073`) record
  which scopes and which private-conversation authors a version was distilled from.
  The learning plan §3 names export explicitly: *"Enforce that basis on … every
  export-capable tool."*
- **`thoughts` is not agent memory.** `packages/memory` writes one table, `Thought`
  (`schema.prisma:5608`), with no `agentId` FK: run consolidation stores rows scoped to
  the **channel** (`consolidate.ts:334`), message capture stores rows scoped to the
  **user** (`user-message-memory.ts:41`). Both are conversational residue with private
  lineage, and the learning plan's stated direction is to migrate durable knowledge out
  of them and into documents. Embeddings (`Thought.embedding`, `KnowledgePageChunk`,
  `MessageEmbedding`) are derived and model-coupled.
- **A clone already exists and already draws half the line.** `POST
  /api/agents/:agentId/clone` → `cloneAgentRecord`
  (`api/src/services/agent-management.ts:50`) copies config, re-owns the copy to the
  cloner, drops `modelSubscriptionId` (a personal plan is not transferable), strips
  protected policy keys (`stripProtectedAgentToolPolicy`), refuses `systemManaged`, and
  goes through `createAgentRecord` so a private clone gets its home DM atomically. It
  does not copy documents beyond the two core ones, checklists, triggers or the avatar.
- **Global agents are blueprints in code, not rows.** `GlobalAgentBlueprint`
  (`packages/team-admin/src/global-agent-blueprints.ts`) has a `buildSystemPrompt`
  *function*, `identityToolIds` the deployment alone may set, and the database CHECK
  forbids a `systemSlug` row that is not `systemManaged` with an organisation.
- **The Designer already does everything an import needs, one tool at a time.**
  `agent_create`, `agent_update`, `agent_read`, `agent_avatar_update`,
  `agent_tool_catalog`, `agent_bind_channel`, `agent_trigger_create`, the `connector_*`
  family, `card_post` with `chips` and `details` blocks — all identity-delegated on its
  own home DM (`worker/src/run/pa-tools/agent-config.ts` for read/update/catalogue/
  avatar, `pa-tools/provisioning.ts` for `agent_create`, bind and trigger; the 09-16
  plan). Its proposal card is a prompt convention, `proposalCardSection()` in
  `global-agent-catalogue.ts`, rendered by the generic `AgentCard` machinery — there is
  no proposal model — with a fold that is the extension point.
- **Files already drop into the DM, not into the page's sidebar.** The Designer's home
  DM is an ordinary channel: `ChannelComposer` takes files (hidden multi-file input, no
  `accept` filter) through `useComposerAttachments` → `POST /api/uploads`, capped at
  `MESSAGE_ATTACHMENT_LIMIT = 10` files per message and `MESSAGE_UPLOAD_MAX_BYTES = 25
  MiB` per file (`packages/schemas/src/messaging.ts`), and `DropZoneOverlay` is wired
  into `ChannelConversationSurface` and `ThreadReplyPanel`. The Agent Designer *page*'s
  sidebar chat (`DesignerChat.tsx`, the client-side form-filling face) has **no**
  attachment or drop affordance at all. On the worker side a run's context gets one
  inventory line per attachment (`worker/src/run/message-attachments.ts`); non-image
  bytes are never injected, and `attachment_read` serves only text-like mimes ≤ 64 KiB
  — so a ZIP needs a server-side reader, not the existing tool.
- **ZIP reading exists; ZIP writing does not.** `api/src/lib/zip.ts` (`listZipEntries`,
  `readZipEntryText`, 64 MiB cap, text-extension allowlist) over `adm-zip`, used only
  by the knowledge-base file preview. Nothing in the estate writes an archive today;
  `adm-zip` can.
- **A review-gated import precedent exists.** Tool bundles: `importBundle`
  (`api/src/services/tool-bundles.ts:86`) parses a manifest through
  `@nessie/connectors` `validateManifestOrThrow`, persists `signatureType`/
  `signatureValue`, and lands the row as `pending_review`. It is a settings-page
  import, not a chat one, and it is the shape to copy for manifest handling.
- **Ed25519 is already in the codebase.** `executor/src/pair.ts:492` generates the
  executor pairing keypair with `generateKeyPairSync('ed25519')`, stores the PKCS8
  private half base64url and derives the raw 32-byte public key from the SPKI suffix.
  Those helpers are the ones to lift; the key itself is per machine, not an identity.
- **A signature precedent, half built.** `NessieToolBundle.metadata.signature`
  (`packages/connectors/src/types.ts:48`) takes `sha256 | ed25519`; `validate.ts:93`
  accepts `ed25519` with a typed `signatureUnimplemented` warning.
- **Two kinds of key exist, and neither identifies an organisation.** The deployment
  signs UOA subject assertions with an RS256 key (`UOA_CONFIG_JWT_KID` +
  `privateKeyPem`, `packages/runtime/src/uoa-delegated-identity.ts:131`) that UOA
  verifies against the *product's* JWKS — one key per deployment, and the hosted
  deployment at `app.nessie.works` serves many organisations. Web push has VAPID keys.
  Nothing today can sign "on behalf of organisation X".
- **A workflow import precedent exists** (`WorkflowImportButton.tsx`,
  `parseWorkflowImport`): JSON file → `createWorkflowTemplate`. It is a button beside
  a list, not a chat affordance, and it verifies nothing.
