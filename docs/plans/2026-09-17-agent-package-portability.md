# Agent packages — export, transfer, and import through the Agent Designer

**Status: design, not built.** Written 2026-09-17 against the code as it stands on
`main` (`52aef2240`). Every "today" statement below was checked against the schema,
the clone route, the blueprint registry and the Designer's tools; every "would"
statement is a proposal. Where a paragraph speculates rather than reports, it says so.

**Related:**
[The Agent Designer](2026-09-02-agent-designer-global-agent.md) (D1 blueprints, D3
identity-delegated tools, D4 toolset, D7 immutability of system agents),
[Designer grants and the proposal card](2026-09-16-agent-designer-grants-and-proposal-card.md)
(the card this plan extends),
[Agent documents and learning](2026-09-08-agent-documents-and-learning.md)
(documents as the durable agent knowledge; §3 is what draws the memory line),
[People and their agents](2026-08-29-people-and-their-agents.md) and
[agent ownership](../standards/agent-ownership.md) (who may export),
[Marketplace and agent library](../marketplace.md) (where a package eventually lists),
[team model](../standards/team-model.md) and `docs/brief.md` → "Current SSO identity
invariant" (what a package may never carry).

## Outcome

A person can take **the whole of an agent** — its instructions, every document in its
Documents home, its checklists, its avatar, its model and tool choices, its schedules
— and export it as one **package**: a single `.nessie-agent` file, or the same thing
unpacked as a folder of Markdown and JSON a person can read and diff. Dropped into the
Agent Designer's conversation on any Nessie — the same instance, another team's, another
organisation's — the Designer recognises it, checks it, shows the standard proposal card
with a trust line, and on **Accept** materialises the agent: portrait, documents,
checklists and all, owned by the person who dropped it, placed where they say.

What a package deliberately does **not** carry: conversations, runs, anything derived
from a private conversation, any person, any organisation or team, any credential, any
grant. Those are either history, or authority — and authority is re-decided on the
receiving side, by the receiving people, through the same chokepoints they already use.

An **authorised package** is one whose provenance UnlikeOtherAI has attested: *this
package was exported by organisation X, by one of its members, for organisation Y,
and has not been altered.* The recipient's Designer verifies that without contacting
anybody, tells the person plainly who it is from, and imports with the source's tool
and app choices pre-selected rather than switched off. An unauthorised package imports
too — it is the recipient's own decision, like pasting a prompt somebody sent them —
but it arrives labelled as text from a stranger, with every capability off until ticked.

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

## Design decisions

### D1 — The package is the agent's documents plus its structured configuration; never its conversations

**Decision.** A package contains exactly: the agent's structured configuration
(everything `CreateAgentBodySchema` accepts, minus `modelSubscriptionId` and
`parentAgentId`, plus `avatarBackgroundColor`), the avatar image bytes, the published
version of every page in the agent's Documents home whose disclosure basis is
**empty**, the two core documents by role, the agent's published `AgentTodoTemplate`
checklists, its triggers as *definitions*, and a **declaration** of every capability
it used that cannot travel. It contains nothing from `Thread`, `Message`, `Run`,
`Thought`, `Demonstration`, or any grant, binding, member or credential table.

The line, stated once: **what the agent knows and how it is configured travels; what
happened to it, who it talked to, and what it was allowed to reach do not.** "Memory"
is the agent's documents. The documents that were *learned* from conversations still
travel — an `Experiences/Delivery delays.md` distilled from a team channel is the
agent's memory in exactly the sense Ondrej means — **unless** its version carries a
non-empty disclosure basis, in which case the far side could never enforce that basis
and the document is withheld and named in the export summary. That is the precise
meaning of "memory but not conversations": the distillate travels when it is
unrestricted; the source never does; a distillate that is itself restricted stays.

The include/exclude table, one row per agent-adjacent table:

| Table | Verdict | Reason |
|---|---|---|
| `Agent` — `name`, `role`, `visibility`, `effort`, `runLimits`, `todosEnabled`, `voiceName`, `speakingStyle`, `provider`, `model`, `avatarBackgroundColor` | **include** | The agent's identity and settings. `visibility` and `todosEnabled` travel as *requested* values: the importer chooses visibility (it is immutable afterwards) and `todosEnabled` keeps its org-owner gate. |
| `Agent.systemPrompt` | include **via documents** | After the core-document migration the column is retired; the package carries `Identity.md` and `Working style.md` by role. A source still on the column is read through `readCanonicalAgentCore`'s legacy fallback and written as those two documents. |
| `Agent.toolPolicy` | include, **rewritten** | Builtin keys are stable ids and travel as-is. Connector keys are per-organisation registry uuids and cannot travel; they become capability declarations (D4) and are re-keyed on import. Protected explicit-grant keys are stripped exactly as `stripProtectedAgentToolPolicy` does for a clone. |
| `Agent.avatarAttachmentId` | include **as bytes** | The image travels in the package and is re-stored through `FileService` on import as a new attachment; the id never travels. |
| `Agent.modelSubscriptionId`, `routingProfileId` | exclude | A personal plan is the exporter's money (the clone precedent); routing profiles are bootstrap-only. Dropping the subscription also drops `provider`/`model` when they were `subscription/*`, so the copy falls to the org default instead of dispatching a value that fails closed. |
| `Agent.agentKind`, `systemManaged`, `systemSlug`, `surfacePolicy`, `delegationMode`, `executionMode` | exclude | Server-set; no create path accepts them; a `systemSlug` row cannot exist un-managed by CHECK. `external_mcp` agents are products, not designs, and are not exportable. |
| `Agent.ownerUserId`, `organizationId`, `teamId`, `projectId`, `parentAgentId` | exclude | Binding-time decisions on the target (D3). A package is always a root agent. |
| `Agent.status`, `deletedAt`, `createdAt`, `updatedAt` | exclude | Runtime and audit. |
| `AgentCoreDocument` | include | The `role → page` mapping is what lets the importer bind the core structurally rather than guess by filename — the learning plan's own rule that roles are never inferred from names. |
| `PersonalAgentCoreOverlay` | exclude | Per-person, on system agents only, stored in that person's My Docs. |
| `AgentCoreDocumentMigration` | exclude | A cutover marker, not data; the importer always writes the migrated shape and its own marker. |
| `KnowledgeSpace` (Documents home) + `KnowledgePage` tree | include | The agent's memory. Folder structure and `position` travel so the far side reads the same way. |
| `KnowledgePageVersion` | include **published only**, basis-empty only | One version per page: the one the agent actually runs on. History is audit trail and often carries the private lineage the basis forbids. A `--history` flag is named in "Later" and not built. |
| `KnowledgePageVersionBasisScope`, `…DisclosureSource`, `KnowledgeDocumentEvidence` | exclude | Tenant provenance; meaningless elsewhere. Their *effect* is applied at export (withhold restricted versions). |
| `KnowledgePageChunk`, `Thought.embedding`, `MessageEmbedding` | exclude, **regenerate** | Derived, embedding-model-coupled (`embeddingModel`/`dims` exist precisely because they go stale). The importer's ordinary indexing jobs rebuild them. |
| `Attachment` (file-kind pages, page attachments) | include bytes | Content-addressed under `files/sha256-<hex>`; the manifest maps page → digest. |
| `KnowledgeSpaceMember`, `KnowledgePageShare` | exclude | ACL naming people. |
| `AgentTodoTemplate` (status `published`) | include | Learned procedures in structured form. Steps referencing tool ids go through the same re-keying as `toolPolicy`. Drafts and proposals stay. |
| `AgentTodo` | exclude | Work in progress in one place. |
| `AgentTrigger` | include as **definitions** | `type`, `name`, `description`, `config` (cron, interval). Never `signingSecret` (a webhook gets a fresh one), never `targetChannelId`/`targetThreadId` (a channel *name* hint only), never health or claim state. Imported **paused** (D6). |
| `AgentBinding` | exclude, name hint only | Channels do not exist on the far side. Placement is the Designer's ordinary job after import. |
| `AgentMailbox` | exclude, **declare** | An address is bound to this instance's domain; `sendPolicy` and `displayName` travel as the declaration so the far side can provision an equivalent. |
| `ToolGrant`, `ExecutorAgentOperationGrant`, `SendAuthorizationGrant`, `MailboxConnectionAgentAccess`, `BrowserPersonalAccessGrant`, `AgentBrowser`, `AgentBrowserLogin` | exclude, **declare** | Authority and credentials. D4 carries the requirement, never the grant. |
| `Demonstration`, `DemonstrationStep` | exclude | Thread-bound, expiring, review-only by its own doc comment. The durable artifact is the `WorkflowTemplate` it generalised into — a later phase may carry those (they reference tool schemas and need the same re-keying). |
| `Thought` and satellites | exclude | Channel- and user-scoped conversational residue with private lineage; the learning plan is moving durable knowledge out of it. Nothing there is "the agent" that its documents are not. |
| `BoardWatcher` | exclude | Bound to a board that does not exist elsewhere. |
| `AgentCard`, `AgentHandoffRequest`, `AgentAppConnectionRequest`, `Favorite` | exclude | Conversation and UI state. |
| `Run*`, `Message`, `Thread`, `Channel`, `EmailConversation`, `EmailMessage` | exclude | The conversations themselves. |

**Rejected.** *Carry `thoughts` narrowly* (`ownerType='agent' AND privateToAgentId`)
flattened into a generated `Experiences/*.md`: a v1 that fabricates a document the
source never had is a v1 that invents memory, and the learning plan is about to make
the same content a real document with real provenance. Wait for that. *Carry full
version history:* doubles the disclosure surface for an audit trail the recipient
cannot act on.

### D2 — One format, two shapes: a `.nessie-agent` ZIP, or the same tree unpacked

**Decision.** The package is a directory tree with a fixed layout, and the single-file
form is that tree zipped with the extension `.nessie-agent` (media type
`application/vnd.nessie.agent-package+zip`). Both forms are one format: the importer
identifies files by **content digest**, not by path, so a folder dropped as loose files
imports identically to the archive — and a folder is what a person reads, edits, and
commits to git.

```text
refund-desk.nessie-agent/            (or refund-desk.nessie-agent as a ZIP)
├── nessie-agent.json                the manifest — the only required file
├── provenance.json                  signature and optional attestation (D5); absent = unsigned
├── avatar.png                       the portrait (png | webp | jpeg), ≤ 5 MiB
├── documents/                       one Markdown file per document page, tree preserved
│   ├── Identity.md
│   ├── Working style.md
│   ├── Product decisions.md
│   ├── Templates/Refund confirmation.md
│   └── Procedures/Handle a refund.md
├── files/                           bytes of file-kind pages and page attachments
│   └── sha256-9f2c…e1.pdf
└── checklists/
    └── refund-triage.json           one AgentTodoTemplate
```

Rules that make an export **reproducible** (two exports of an unchanged agent are
byte-identical, which is what makes a digest meaningful and a git diff quiet):

- UTF-8 without BOM, `\n` line endings, Unicode NFC, for every text file. Markdown is
  written byte-for-byte from the canonical attachment bytes where the page has them
  (`sourceContentHash` is then the file's digest), else from `body`.
- The manifest is written as canonical JSON (RFC 8785: sorted keys, no insignificant
  whitespace, shortest number form) and its `contents[]` lists every other file with
  its SHA-256. `provenance.json` is the one file *not* listed, since it signs the
  manifest.
- ZIP entries are sorted by path, stored with the fixed timestamp `1980-01-01T00:00:00Z`,
  no extra fields, no per-entry comments, deflate at a fixed level. Nothing in the
  archive says when it was made; the manifest's `exportedAt` does, and it is excluded
  from the digest that `provenance.json` signs (D5) so re-signing does not change the
  package identity.
- Document paths are derived from titles by one deterministic slug rule, deduplicated
  with a numeric suffix; the manifest is the authority for title, role and tree
  position, the path is a convenience.

Limits, enforced at export and import, and sized to the door the package goes through
— the chat composer's `MESSAGE_UPLOAD_MAX_BYTES` (25 MiB per file) and
`MESSAGE_ATTACHMENT_LIMIT` (10 files per message): whole package ≤ **24 MiB**;
manifest ≤ 1 MiB; documents ≤ 8 MiB of text; files ≤ 12 MiB; avatar ≤ 2 MiB;
≤ 2 000 documents; ≤ 200 checklists; ≤ 50 triggers. The **folder form** drops into
chat only when it has ≤ 10 files; a bigger folder is zipped first, which the export
summary says. An export that would exceed a limit fails naming the limit and the
largest offenders; it never silently trims. An agent whose file-kind documents are
genuinely heavier than this is a knowledge-space transfer wearing an agent's name, and
the existing knowledge transfer path (`knowledge-transfer-run.ts`) is the right door
for the bulk, with the package carrying the rest — raising the composer caps for this
one media type is an open question, not a default.

Worked manifest for a realistic agent, `nessie-agent.json`:

```json
{
  "schemaVersion": 1,
  "kind": "nessie.agent-package",
  "packageId": "2f1c4a6e-8d3b-4c0e-9a71-5b2d8e6f1a03",
  "lineage": {
    "key": "c9b0e2d4-1f57-4a8e-b6c3-0d9e8f7a6b51",
    "packageVersion": 3,
    "previousPackageId": "0b7e1d3a-6c2f-4e9b-8a5d-3f1c2e4b6a90"
  },
  "producer": { "app": "nessie", "version": "2026.9.17", "instanceKind": "hosted" },
  "exportedAt": "2026-09-17T09:14:02Z",
  "agent": {
    "name": "Refund Desk",
    "role": "support specialist",
    "visibility": "team",
    "effort": "medium",
    "runLimits": { "maxToolCalls": 40, "maxWallclockMs": 600000 },
    "todosEnabled": true,
    "voiceName": "Kore",
    "speakingStyle": null,
    "model": { "provider": "openai", "model": "gpt-5.1", "fallback": "organization-default" },
    "avatar": { "file": "avatar.png", "sha256": "4c1f…9a", "backgroundColor": "#b5462f" }
  },
  "core": {
    "identity": "documents/Identity.md",
    "working_rules": "documents/Working style.md"
  },
  "documents": [
    { "path": "documents/Identity.md", "title": "Identity", "role": "identity",
      "kind": "document", "sha256": "e3b0…55", "trust": "explicitly_confirmed",
      "origin": "user_authored", "position": 0 },
    { "path": "documents/Working style.md", "title": "Working style", "role": "working_rules",
      "kind": "document", "sha256": "a1d2…07", "trust": "explicitly_confirmed",
      "origin": "user_authored", "position": 1 },
    { "path": "documents/Product decisions.md", "title": "Product decisions", "role": "knowledge",
      "kind": "document", "sha256": "77c0…3e", "trust": "observed",
      "origin": "agent_authored", "position": 2 },
    { "path": "documents/Templates/Refund confirmation.md", "title": "Refund confirmation",
      "role": "template", "kind": "document", "sha256": "0f9e…b2", "trust": "explicitly_confirmed",
      "origin": "user_authored", "folder": "Templates", "position": 0 },
    { "path": "documents/Procedures/Handle a refund.md", "title": "Handle a refund",
      "role": "procedure", "kind": "document", "sha256": "5d6a…c4", "trust": "observed",
      "origin": "agent_authored", "folder": "Procedures", "position": 0 },
    { "path": "files/sha256-9f2c…e1.pdf", "title": "Refund policy 2026.pdf", "role": "knowledge",
      "kind": "file", "mime": "application/pdf", "sha256": "9f2c…e1", "sizeBytes": 184322,
      "trust": "explicitly_confirmed", "origin": "user_authored", "position": 3 }
  ],
  "withheld": {
    "documents": 2,
    "reason": "restricted disclosure basis"
  },
  "toolPolicy": {
    "builtin": { "web_search": true, "kb_search": true, "delegate": false, "spawn_subtask": false },
    "connectors": [
      { "ref": "stripe", "toolIds": ["stripe.refund_create", "stripe.charge_read"] },
      { "ref": "zendesk", "toolIds": ["zendesk.ticket_read", "zendesk.ticket_comment"] }
    ]
  },
  "capabilities": {
    "connectors": [
      { "ref": "stripe", "catalogueKey": "stripe", "name": "Stripe", "scope": "organization" },
      { "ref": "zendesk", "catalogueKey": "zendesk", "name": "Zendesk", "scope": "team" }
    ],
    "grants": [
      { "kind": "mailbox_connection", "why": "reads the support@ inbox" },
      { "kind": "send_authorization", "why": "replies to customers" }
    ],
    "mailbox": { "wanted": true, "sendPolicy": "approval_required", "displayName": "Refund Desk" },
    "cloudBrowser": false,
    "executorOperations": []
  },
  "checklists": [
    { "path": "checklists/refund-triage.json", "name": "Refund triage", "sha256": "31aa…d8" }
  ],
  "triggers": [
    { "type": "scheduled", "name": "Morning refund sweep",
      "config": { "cron": "0 8 * * 1-5", "timezone": "Europe/Prague" },
      "targetChannelHint": "support-refunds" }
  ],
  "placementHints": { "team": "Customer Support", "channels": ["support-refunds"] },
  "contents": [
    { "path": "avatar.png", "sha256": "4c1f…9a" },
    { "path": "documents/Identity.md", "sha256": "e3b0…55" },
    { "path": "documents/Working style.md", "sha256": "a1d2…07" },
    { "path": "documents/Product decisions.md", "sha256": "77c0…3e" },
    { "path": "documents/Templates/Refund confirmation.md", "sha256": "0f9e…b2" },
    { "path": "documents/Procedures/Handle a refund.md", "sha256": "5d6a…c4" },
    { "path": "files/sha256-9f2c…e1.pdf", "sha256": "9f2c…e1" },
    { "path": "checklists/refund-triage.json", "sha256": "31aa…d8" }
  ],
  "extensions": {}
}
```

Three things to notice. `lineage.key` is the source agent's own id the first time it
is exported, and is carried forward by every re-export — that is what makes "same
agent, newer version" recognisable (D6) without a new column on `Agent`.
`toolPolicy.connectors[].ref` points into `capabilities.connectors`, which names the
**catalogue** entry, never a registry uuid, endpoint or credential. `placementHints`
is prose for the Designer to *say*, never something the importer acts on — a channel
name is not a channel.

**Rejected.** *JSON only, everything inline* (the workflow-export shape): a package with
forty documents becomes one unreadable blob, and the folder form — the one a person
can review in a pull request — is the one that makes "authorised" mean anything, since
you can see what you are signing. *A tarball:* nothing in the estate reads tar;
`adm-zip` is already here. *Trusting paths for identity:* a browser drop of a folder
does not reliably keep relative paths; digests do.

### D3 — Identity and tenancy are never in the package; every binding is decided on the target

**Decision.** The manifest has no field for a person, an organisation, a team, a
project, a membership, an email, a display name or an avatar of a human. The exporter
strips them; the parser refuses a manifest that carries any of them under a known key
(`.strict()` on every object, so an added `ownerEmail` is a schema error, not a
silently ignored field). On import:

- **Owner** is the person in the Designer DM — `effectiveUserId`, which the
  single-member system DM stamps by construction and the identity-delegated gate has
  already verified is a live human on an interactive turn. Always. A package cannot
  ask for a different owner, and a team-owned agent (`ownerUserId: null`) is a release
  the importer performs afterwards with the existing transfer path if they want it.
- **Organisation** is the DM's organisation; the created row goes through
  `createAgentRecord`, whose composite FK proves the owner is a live member of that
  organisation — the same storage-boundary tenancy check every agent gets.
- **Team and project** come from the conversation, exactly as they do for a designed
  agent: the Designer resolves the name the person uses with `project_list`, or asks.
  `placementHints` is something it may *mention* ("on the other side this lived in a
  team called Customer Support") — it resolves nothing by itself.
- **Parent agent** is never set. A package is a root agent; `spawn_subtask` children
  inherit owner and visibility from their runtime parent and are not a design.
- **Visibility** defaults to the package's value and is confirmed on the card, because
  it is immutable afterwards; a private agent is created with its owner-only home DM
  atomically by the chokepoint.

When the source referenced a person or a team that has no counterpart — a document
that says "escalate to Marek", a checklist step assigned by name — nothing structural
happens, because nothing structural was carried. The text says what it says; the
Designer's post-import walkthrough (D4) points out that names in the documents refer to
people on the other side. On a no-IdP install the same rules hold with the unbound
organisation and its local `User` rows; the invariant is the same, only the roster
source differs.

Provenance is the one place a **UOA organisation** is named, and only inside the
UOA-signed attestation (D5), where it is UOA-authored display data exactly like the
billing display models — never a local copy. Nessie stores from it only the UOA
organisation id on the import ledger row (D6), which is a stable reference, not a
profile.

**Rejected.** *Carry the owner's UOA subject so the same person importing elsewhere
gets it back:* a subject is meaningful only inside its organisation
(`resolveLocalUserIdsByUoaSub` is org-scoped for exactly this reason), and the benefit —
skipping a question the Designer never asks anyway — is nil. *Carry the source team id
as a placement default:* the team may not exist, and if it does the person should still
say so; a silent default is the ambient-context narrowing Rule zero forbids.

### D4 — Grants and secrets are declared, never carried; the Designer wires them after import

**Decision.** Every capability the source agent had that is authority rather than
configuration becomes a `capabilities.*` declaration: connectors by catalogue key,
explicit-grant tools by kind, the mailbox as a wish, executor operations by
`operationKey`, the cloud browser as a flag. No token, secret, connection id, grant row
or login travels — and the manifest schema has nowhere to put one.

On the receiving side the declaration drives a **resolution**, computed by
`agent_package_inspect` (D6) and shown on the card's fold, one chip per requirement:

| Declaration | Resolved as | What the Designer does |
|---|---|---|
| connector installed here at org or team scope | *satisfied* — policy key re-written to the local registry uuid | grants it in the create call; says nothing further |
| connector installed only at a person's scope | *personal* | grants it, and says colleagues will not reach it (the 09-16 rule) |
| connector not installed, in the library | *installable* | offers to install it now with `connector_install` — the person's own connector rights, the same refusal an owner-only scope gets on the Apps page |
| connector unknown to this deployment | *unavailable* | lists it as missing; the agent is created without it |
| explicit-grant tool (mailbox, calendar, deep research, browser, DeepWater) | *owner-granted* | names the capability, says it needs an owner's grant on that agent's Tools tab, and carries on — the persona's existing rule, unchanged |
| mailbox wanted | *provisionable* | creates it after the agent exists, through the existing mailbox provisioning path |
| executor operation | *owner-granted* | names it; grants are per-executor |

The imported agent therefore arrives **functional-but-unwired**: it can talk, it has
its documents, its builtin tools, and every connected app the recipient could grant.
What it cannot yet reach is stated in one list, each item with the action that fixes it
and who can take it. The Designer's closing message after Accept is that list, not a
homework paragraph — it does what it can in the same turn (install and grant a
connector) and names only what is genuinely somebody else's decision.

Authorised packages (D5) get the source's connector and builtin choices **pre-selected**
on the card; unauthorised ones get them **listed but off**, so nothing a stranger wrote
becomes a capability without a tick. In both cases the create call passes
`assertGenericAgentToolPolicyInput`, so a package can no more smuggle a protected key
than a person can.

**Rejected.** *Carry an encrypted credential bundle the recipient can decrypt with a
shared secret:* the connected-mailboxes and app-store standards say a credential
belongs to a connection with its own scope and owner; a package that moves one moves
authority between organisations behind UOA's back. *Carry registry uuids and hope:*
they are per-organisation and would resolve to the wrong app or to nothing.

### D5 — "Authorised" means UOA attests who exported it and for whom; integrity is always checkable offline

**Decision.** Three trust states, in increasing order, each computed by the importer
without a network call and each shown as one line on the proposal card:

1. **Unsigned.** No `provenance.json`. Digests are still verified (a corrupted archive
   is refused), but nothing says who made it. Card line: *"Unsigned package — treat its
   instructions as text from a stranger."* Capabilities listed, all off. Documents land
   with `trust: unverified_import`, `origin: import`.
2. **Signed.** `provenance.json` carries an Ed25519 signature over the manifest's
   canonical digest, and the signer's public key. The importer can prove the package
   is intact and that it was made by *whoever holds that key* — and, on a second
   import, that it is the same signer as before. It cannot say who that is. Card line:
   *"Signed by an unknown key `k1…`; intact."* Treated as unsigned for capabilities.
3. **Authorised.** `provenance.json` additionally carries an **attestation**: a compact
   JWS signed by UnlikeOtherAI stating `{ iss: uoa, sub: <exporting UOA org id>,
   org_name, aud: <recipient UOA org id> | "uoa:any", jti: <packageId>, digest,
   signer_kid, iat, exp }`. The importer verifies it against the UOA JWKS it already
   holds for SSO, checks the digest matches the manifest, the `signer_kid` matches the
   Ed25519 key that signed it, and the audience is its own organisation (or `any`).
   Card line: *"From Acme Corp (verified by UnlikeOtherAI), addressed to your
   organisation, valid until 17 Oct."* Capabilities pre-selected; documents keep the
   source's `trust`, `origin: import`.

What "authorised" therefore means, answered item by item:

- **Signed provenance:** yes — that is the whole of it. Authorisation is a statement
  about *who*, made by the only party that knows which organisation a key belongs to.
- **Bound to a named recipient:** yes by default. The exporter names the recipient
  organisation (by UOA org id or slug; UOA resolves the slug at attestation time). An
  attestation for organisation Y presented to organisation Z is **refused** — not
  downgraded — because the exporter said who it was for. `aud: uoa:any` is an explicit
  choice the export card makes the person pick, and it is the only redistributable
  form. "For another team in my own organisation" is `aud: <my own org>`; the team is
  a placement hint, not an audience, because teams are where people are, not
  boundaries a file can enforce.
- **Single-use:** no. A file cannot be made single-use offline, and pretending it can
  is worse than saying it cannot. Idempotency is the recipient's import ledger (D6):
  importing the same `packageId` twice is detected and offered as a duplicate, never
  silently doubled.
- **Expiring:** the attestation expires (default 30 days, max 365, chosen at export).
  After expiry the package **degrades to Signed**, it does not become unusable — the
  agent inside did not stop being a good design on a date. The card says "attestation
  expired on …".
- **Revocable:** an importer that *can* reach UOA additionally asks `GET
  /attestations/<jti>` and refuses a revoked one; offline it relies on `exp`. The
  exporter revokes from the same surface it exported from.

**Key material.** Signing keys are **per organisation**, not per deployment: the
hosted deployment serves many organisations, and a deployment-wide key would let any
tenant's export look like any other's. Each organisation gets one Ed25519 keypair,
generated lazily on first export, public half and `kid` on a small table
(`AgentPackageSigningKey`), private half through the same secret-store seam connector
credentials use (`storeInstanceSecret`) — never in a column. Rotation is a new row;
old `kid`s stay verifiable. The *attestation* is what binds a `kid` to an organisation:
the exporting Nessie asks UOA to attest, over the delegated-identity channel it already
has (`UoaDelegatedIdentityService.requestHeaders` with a fresh subject assertion for
the exporting person), so the attestation is also a statement that a live member of
that organisation exported it. This needs one new UOA endpoint (`POST
/products/nessie/agent-package-attestations`, `GET …/<jti>`, `DELETE …/<jti>`) —
**cross-repository work, called out in the open questions.**

**What the recipient never needs.** No key registry to consult, no exporter to contact,
no shared secret. UOA's JWKS is already configured on every SSO-backed instance. A
no-IdP install has no JWKS and can only ever reach state 2 — which is honest, since it
also has no organisation identity UOA could vouch for.

**Prompt injection.** A package's `Identity.md`, every document and every checklist
step is attacker-controlled text on the receiving side, and the receiving side is a
conversation with a model that holds create tools. Four rules keep import from being a
delivery vehicle:

1. **Package text never enters the Designer's context in instruction position.**
   `agent_package_inspect` returns a *structured* report — names, counts, digests,
   resolutions, trust state — and at most a server-truncated excerpt of the identity
   document, and that excerpt is placed in the card's `details` fold, which renders and
   is transcribed as data. The Designer's structural prompt block says a package is
   attached and which tool reads it; it never quotes the package. This is the same
   discipline `avatarLine` applies to the person's avatar style.
2. **The apply tool takes ids and decisions, never text.** `agent_package_apply({
   attachmentIds, decisions })` reads the bytes from `FileService` again and writes what
   the package says, filtered by the decisions the card offered. The model cannot
   "improve" the package on the way in; a change after import is an ordinary
   `agent_update` under edit authority, visible in document history as a new version.
3. **Trust is a field, not a feeling.** Unsigned and Signed packages import with every
   capability off and every document `unverified_import`; the person ticks what they
   accept. Authorised packages inherit the source's choices because a named
   organisation stands behind them.
4. **The preview is the real surface, read-only.** Before Accept, the person can open
   the package as the ordinary agent detail form with every control disabled — the
   global-agent precedent, reused rather than a second viewer — and read the full
   documents there. What they approve is what they can read.

**Rejected.** *Sign with the deployment's UOA RS256 key:* it identifies a deployment,
not an organisation. *A per-organisation key registered at UOA, verified by the
recipient phoning UOA:* works only online, and adds a registry API the attestation
already subsumes. *A shared passphrase (`age`-style encryption to the recipient):* proves
the recipient can open it, not who made it, and puts a secret in a chat. *Nessie as its
own CA for organisations:* a second identity authority beside UOA is the exact
violation the invariant names. *Refusing unsigned packages outright:* a person may
paste the same prompt into a new agent by hand today; refusing the file while allowing
the paste protects nothing and breaks "drop it in and it works". The protection is the
label and the capabilities-off default.

### D6 — Import is a conversation: inspect, propose, accept, wire — and the ledger makes it idempotent

**Decision.** The whole path, in order:

1. **Drop.** The person drops a `.nessie-agent` file or the unpacked folder into the
   Agent Designer DM. The existing composer stores each as an attachment through
   `FileService` and links it to the message. Nothing new on the client for the DM.
   The Agent Designer **page** is the other place a person is standing with a file in
   hand, and its sidebar cannot take one — so it gets a `DropZoneOverlay` (the shared
   component, not a new one) whose drop uploads the files and hands off to the DM
   through the existing "Continue in chat" mechanism (`useContinueDesignInChat` →
   `agent_handoff`'s server-authored kickoff, with the attachment ids on the kickoff
   message). One import home, two doorways, per Rule zero.
2. **Detect — structurally.** At run setup, the worker sees an attachment whose
   filename ends `.nessie-agent`, or a set of attachments among which one is named
   `nessie-agent.json`. That is a structural fact about a file name, not a judgement
   about content (the no-string-matching rule concerns message meaning; an explicit
   manifest file is an entity reference like an @mention). The structural prompt block
   for the Designer gains one line: *"An agent package is attached (`<file>`); read it
   with `agent_package_inspect` before saying anything about it."*
3. **Inspect.** `agent_package_inspect({ attachmentIds })` — identity-delegated,
   Designer-only, added to `AGENT_DESIGNER_BLUEPRINT.identityToolIds`. The server
   opens the bytes, verifies every digest, parses the manifest under the versioned
   schema (D7), verifies `provenance.json` (D5), resolves every capability (D4), checks
   the model against the live catalogue, and consults the **import ledger**
   (`AgentPackageImport`: `organizationId`, `agentId`, `lineageKey`, `packageId`,
   `packageVersion`, `contentDigest`, `signerKid`, `attestedOrgId`,
   `importedByUserId`, `importedAt`) for collisions. It returns the structured report.
   This **is the dry run**; nothing is written.
4. **Propose.** The Designer posts the standard proposal card, extended in place rather
   than replaced: `title` name / `subtitle` role; the three-line "what it does"; **a
   `fields` row "From"** carrying the trust line; "Where it lives" from the
   conversation; the model `select` defaulting to the package's model when the
   catalogue has it, else the recommendation with a note; and inside the `details` fold:
   `chips` of builtin tools, `chips` of apps with their resolution, `chips` of
   documents by role with counts, the withheld count, the triggers, and the identity
   excerpt. When the ledger found a collision, one more `select`: **Create a copy /
   Update the existing agent**. Actions: **Accept**, **Edit**, **Discard**.
5. **Accept.** `agent_package_apply({ attachmentIds, decisions })` runs one transaction:
   `createAgentRecord` (owner = the person, visibility as chosen, policy re-keyed and
   asserted), avatar bytes stored through `FileService` and set with the avatar
   service, core documents written with `writeCanonicalAgentCore`, the Documents home
   provisioned through `ensureAgentDocsSpace` and every other document written through
   the knowledge provider with `origin: import` and the trust the trust state allows,
   checklists created published, triggers created **paused**, the ledger row written.
   Then, outside the transaction, the ordinary indexing jobs rebuild chunks and
   embeddings. The Designer says what landed and where — the agent's detail page and
   its Documents tab — and then walks the D4 list.
6. **Wire.** Install and grant what it can; name what it cannot; bind to the channels
   the person names; offer to unpause the triggers once the agent is placed (a
   scheduled trigger also needs the creator's live SSO identity, which the existing
   `createAgentTrigger` refusal enforces).

**Collisions and re-import.** The ledger keys on `lineage.key`:

- **Same `packageId` again** → "you already imported exactly this on … as *Refund
  Desk*" with the copy/update choice; default *copy*, named `(copy)` like a clone.
- **Same lineage, newer `packageVersion`** → the choice defaults to **update**: the
  existing agent's config is patched through `updateAgentRecord` under the importer's
  edit authority (refused in words when they lack it), each changed document gets a new
  version with `origin: import` so history shows the upgrade as a diff, checklists are
  reconciled by name, triggers by name (still paused if new). Grants, bindings, the
  mailbox and the owner are **never touched by an update**.
- **Same lineage, older or equal version** → default *copy*, with the note.
- **Lineage key equals an agent id in this organisation** — the package came from
  *here* → this is "duplicate an agent", and it is the same path with the copy
  default. The clone route stays for the button; the package is the clone that carries
  the documents, and folding the clone route onto the package builder is named in the
  phases.

**Partial import.** `decisions.omit` lists document paths, checklist names and trigger
names to leave out; the card's fold is where the person unticks them (chips are not
inputs, so the Designer offers "leave out the procedures" as an Edit turn and re-posts).
**Rollback.** The apply is atomic; after commit, undo is the existing soft delete,
which already revokes every live capability, and the Designer offers it by name in the
turn after import ("if this is not what you wanted, say so and I will remove it").

**Rejected.** *A dedicated upload page or wizard:* Ondrej asked for the file dropped
into the Designer, and the Designer already owns proposal, placement and wiring; a
wizard would be the second brain D9 removed. *Silently updating on re-import:* an
update rewrites documents somebody may have edited locally; it must be a visible choice
with the existing agent named. *Importing triggers active:* an unattended run on an
agent nobody has placed yet, on a schedule a stranger wrote.

### D7 — One integer schema version, additive by default, strict on the unknown that matters

**Decision.** `schemaVersion` is a single integer, bumped only for a change an older
importer could not read correctly. Additive fields do not bump it. Rules:

- **Older package, newer Nessie:** always imports. The importer applies per-version
  upgraders in sequence (`upgradeManifestV1toV2`, …), pure functions in the contract
  package, tested with a fixture package per version kept under `test/fixtures/agent-packages/`.
- **Newer package, older Nessie:** if `schemaVersion` is greater than the importer's,
  refuse with the sentence *"this package needs a newer Nessie (schema 3; this instance
  reads up to 2)"*. Never partially import a shape you do not understand.
- **Unknown top-level or nested fields** are a schema error (every object is
  `.strict()`), *except* under `extensions`, which is preserved verbatim, ignored, and
  round-tripped on re-export. That is the one forward-compat channel, so a future field
  is trialled there before it is promoted.
- **Unknown enum values** (a document role, a trigger type, an effort) are refused with
  the field named; a role the importer does not know cannot be silently demoted to
  `knowledge` without changing what the agent is.
- **Unknown builtin tool keys** in `toolPolicy.builtin` are dropped and listed on the
  card ("not on this instance: `deepwater_query`"), since a tool key is capability, not
  identity, and the catalogue is the authority on what exists here.
- **Signature verification is version-independent:** it covers the canonical manifest
  bytes as written, before any upgrader runs, so an upgraded reading never invalidates
  a signature.

The contract lives in `packages/schemas/src/agent-package.ts` beside `AgentRecordSchema`,
so the manifest's field vocabulary is the product's own and a new `Agent` column that
should travel is added in one place with its upgrader.

**Rejected.** *Semver on the manifest:* three numbers invite a "minor" that quietly
changes meaning; one integer with "additive never bumps" is the whole policy. *Lenient
parsing of unknown fields everywhere:* the invariant in D3 depends on a stray
`ownerEmail` being an error, not a warning. *Best-effort import of a newer schema:*
a half-understood agent is a different agent.

### D8 — Export takes edit authority; import takes create authority; system agents never travel

**Decision.**

- **Who may export.** Exporting is stronger than reading: it takes the agent's full
  configuration and every document *out of* disclosure enforcement. So the gate is
  `resolveAgentEditAuthority` — the live owner or an org owner/admin for a person-owned
  agent, anyone entitled plus owners/admins for a team-owned one, the live owner alone
  for a private one, and `SYSTEM_AGENT_IMMUTABLE` for a system-managed one — **and**
  `canReadSpace` on the Documents home (the clone route's own check). Export writes an
  audit event `agent.exported` with the package digest and the withheld count.
- **Does exporting leak organisation data?** It can carry what the documents say, the
  names of connected apps, and channel names as hints. Three controls: restricted
  versions are withheld by basis (D1); connector declarations carry catalogue keys and
  names only — never endpoints, scopes' contents or credentials; and the export summary
  lists every document and hint before the file is produced, so what leaves is what
  the person saw. `placementHints` can be switched off on the export card.
- **Who may import.** Anyone who may create an agent — the same people `agent_create`
  serves. `todosEnabled` keeps its org-owner gate (the Designer relays the refusal),
  triggers keep theirs, connector scopes keep theirs.
- **`visibility` / `surfacePolicy`.** A private agent exports (its owner's alone) and
  imports private by default; `surfacePolicy` and `delegationMode` are server-set and
  not carried, so a `dm_only` external product cannot be exported into a shared agent.
- **`systemManaged`.** Not exportable, by the same refusal that makes them uneditable.
  The Agent Designer, the Dashboard Designer and the Personal Assistant are blueprints
  and org singletons; a package of one would be a `systemManaged` row on the far side,
  which the CHECK forbids un-managed and the bootstrap would fight managed.

**Blueprint ↔ package.** A blueprint is *code*: `buildSystemPrompt` is a function,
`identityToolIds` is deployment authority. A package is *data*. So: **package → blueprint,
never** — nothing a person imports can become system-managed. **Blueprint → package,
yes, one-way and later:** `packageFromBlueprint(blueprint, ctx)` evaluates the prompt
for the organisation, drops `identityToolIds`, and emits an ordinary package that
imports as an ordinary user-owned agent — "give me my own copy of the Dashboard
Designer to change". Same family of idea, opposite direction of authority: a blueprint
is what the *deployment* says an agent is; a package is what a *person* says one is.

**Rejected.** *Export on read entitlement alone:* anyone who can see a team agent could
then carry its documents out of disclosure enforcement — export is the one read that
escapes the sink, so it takes the authority editing takes. *Import gated on org
owner:* creating an agent is any member's action today, and the narrower gates
(`todosEnabled`, triggers, connector scope) already sit on the things that need them.
*A `systemManaged` flag in the manifest for "official" packages:* that is a second
way to mint a system row, and the CHECK exists to make it impossible.

### D9 — One builder, one parser, in `@nessie/team-admin`; the API streams, the worker imports

**Decision.** Export and import share code with the routes they mirror, per the
route-mirroring rule:

- `packages/schemas/src/agent-package.ts` — manifest schema, upgraders, limits.
- `packages/team-admin/src/agent-package/` — `build.ts` (agent + documents + files →
  tree, canonical JSON, deterministic ZIP), `parse.ts` (bytes or attachment set → tree,
  digests verified), `verify.ts` (signature, attestation, trust state), `resolve.ts`
  (capabilities against this organisation, model against the catalogue, ledger
  collisions), `apply.ts` (the transaction). None of it touches `prisma.attachment`
  bytes directly; all bytes go through `FileService`.
- `api/src/routes/agents.ts` gains `GET /api/agents/:agentId/export` (streams the ZIP;
  query `audience`, `expiresInDays`, `placementHints`) and `POST …/export/attest`. The
  admin's agent detail header gets **Export package…** with a small card-shaped dialog
  for audience and expiry — the doorway where a person is standing when they want it.
- The Designer gains `agent_export` (posts the package into the DM as an attachment
  with the trust line, so "give me Refund Desk as a package I can send to Acme" is one
  sentence), `agent_package_inspect` and `agent_package_apply`, all identity-delegated.
  `buildGlobalAgentCatalogueBlock` under `writeSurface: 'agent_tools'` gains the
  generated paragraph that describes them; the persona is untouched.
- `POST /api/agents/:agentId/clone` is re-pointed at `build → apply` in-process in the
  same organisation, so a clone finally carries documents, checklists and the avatar,
  and there is one copier rather than two.

**Rejected.** *Builder in `api/src/services` and a second parser in the worker:* the
D9 lesson of the Designer plan — two processes, one brain — applies verbatim; the
worker imports and the API exports, and both must read the same bytes the same way.
*Import as an API route the Designer calls over HTTP:* the identity-delegated tools
call shared functions directly and re-derive authority from the live membership row;
a self-call over HTTP would need a token that does not exist and should not.

## Security invariants

1. **Nothing in a package is authority.** The schema has no field for a credential,
   grant, membership, person, organisation or team; the parser is strict; the apply
   step passes every policy through `assertGenericAgentToolPolicyInput` and every
   creation through `createAgentRecord` and its composite FK.
2. **Package text never sits in instruction position for the Designer.** The inspect
   result is structured; the excerpt is in a data block; the apply tool takes ids.
3. **Trust is computed offline and shown as a fact.** Unsigned / Signed / Authorised,
   from digests, an Ed25519 signature and a UOA-signed attestation against the JWKS
   already configured for SSO. An audience mismatch refuses; an expiry degrades.
4. **Disclosure is enforced at export.** A version with a non-empty basis never leaves;
   the count of withheld documents is on the card.
5. **Imports are idempotent and reversible.** The ledger detects the same package and
   the same lineage; an update never touches grants, bindings, mailbox or owner; undo is
   the existing soft delete with its revocations.
6. **No new hierarchy, no UOA duplication.** The only identity fact stored from an
   import is the attesting UOA organisation id on the ledger row.

## Phases

Each phase ships on its own and is useful on its own. Prisma migrations are flagged;
none touches an existing migration file.

0. **Contract.** `packages/schemas/src/agent-package.ts` (schema v1, limits, upgrader
   scaffold) and `packages/team-admin/src/agent-package/{build,parse}.ts` with
   deterministic-output tests (two builds of one fixture are byte-identical; a folder
   and its ZIP parse to the same tree; every limit refuses with its name). No
   migration, no surface — it is a library phase and says so.
1. **Export.** `verify.ts` for the digest-only path, `GET /api/agents/:agentId/export`,
   the detail-page **Export package…** doorway, `agent.exported` audit, the Designer's
   `agent_export`. Restricted versions withheld and counted. Independently valuable:
   a person can back up an agent, read it as a folder, put it in git. No migration.
2. **Import through the Designer.** `resolve.ts`, `apply.ts`,
   `agent_package_inspect` / `agent_package_apply` in
   `worker/src/run/pa-tools/agent-package.ts`, the structural detection block in
   `run-setup.ts`, the proposal-card extension (trust `fields` row, contents fold,
   collision `select`) in `proposalCardSection()`, the read-only package preview on
   the designer form, the Designer page's drop doorway onto the DM, a ZIP *writer*
   beside the reader in `api/src/lib/zip.ts`, the D4 wiring walkthrough, and the
   clone route re-pointed. **Migration:** `AgentPackageImport`. Unsigned and Signed
   packages both import, labelled.
3. **Authorised packages.** Per-organisation Ed25519 keys, the export card's audience
   and expiry, `POST …/export/attest`, attestation verification against the UOA JWKS,
   online revocation check when reachable, the Authorised trust line and pre-selected
   capabilities. **Migration:** `AgentPackageSigningKey`. **Cross-repo:** the UOA
   attestation endpoints. Until UOA ships them, phase 3 lands with the Signed state
   only and the attestation path behind the endpoint's presence.
4. **Later, named and not built.** `packageFromBlueprint`; a `--history` export
   carrying versions whose basis is empty; multi-agent bundles (a folder of packages
   with a `nessie-bundle.json` naming their handoff relationships); derived
   `WorkflowTemplate`s; and a marketplace listing — an `agent_package` library item
   type in `docs/marketplace.md` §1, installed by exactly this import path.

## Verification

- Contract tests under `packages/team-admin/test/agent-package/`: determinism, folder
  ≡ ZIP, limits, strictness (an `ownerEmail` field is a schema error), every upgrader
  against its fixture, signature over canonical bytes surviving an upgrade.
- DB-backed API tests (`DATABASE_URL` exported, through Turbo): export gated by edit
  authority and `canReadSpace`; withheld-by-basis; system agent refused; import creates
  owner = importer with the composite FK satisfied; policy re-keying; protected keys
  stripped; the ledger's copy/update branches; update never touches grants or
  bindings; triggers paused; an audience mismatch refused.
- Worker tests: the structural detection line appears only when a manifest-named
  attachment exists; `agent_package_inspect` output contains no document body outside
  the excerpt; `agent_package_apply` refuses model-supplied text fields.
- Browser: extend `test:e2e:agent-proposal-card` with the imported-package card —
  the trust row present, the contents fold closed on arrival, the collision select when
  a ledger row exists; a fixture package under `admin/e2e/agent-proposal-card/`.
- Mock-LLM smoke: drop the fixture package into the Designer DM, accept, assert the
  agent, its Documents home page count, the avatar attachment and the paused trigger
  exist and the ledger row is written.

## Open questions for Ondrej

1. **UOA attestation endpoint.** Phase 3 needs three small UOA routes. *Recommend:*
   yes, it is the only way "authorised" can mean an organisation rather than a key;
   ship phases 0–2 first, phase 3 lands with Signed only until UOA is ready.
2. **Default audience for an authorised export.** *Recommend:* a named recipient
   organisation is required and `anyone` is an explicit pick on the export card;
   "another team here" is my own organisation as audience with the team as a hint.
3. **Should unsigned packages import at all?** *Recommend:* yes, labelled, with every
   capability off — refusing the file while allowing the same text pasted by hand
   protects nothing.
4. **Restricted learned documents.** Withhold and count (recommended), or offer the
   original authors an exact-content disclosure grant so a restricted experience can
   travel? *Recommend:* withhold in v1; the grant path is the learning plan's own later
   phase and should ship there, not here.
5. **Published version only, or history?** *Recommend:* published only in v1; history
   as a later flag, basis-filtered per version.
6. **Triggers paused on import, even when authorised?** *Recommend:* always paused;
   unpausing is one word in the DM after placement, and an unplaced agent on a schedule
   a stranger wrote is the wrong default.
7. **Re-point the clone route at the package builder** so a clone carries documents and
   the avatar, or leave the clone shallow? *Recommend:* re-point in phase 2; two copiers
   is the fork Rule zero names.
8. **Attestation lifetime.** *Recommend:* 30 days default, 365 maximum, expiry degrades
   to Signed rather than refusing.
9. **Package size versus the chat door.** The composer caps a file at 25 MiB and a
   message at 10 files, so a package is ≤ 24 MiB and a folder drop ≤ 10 files.
   *Recommend:* live with it in v1 — an agent heavier than that is mostly a knowledge
   space, which has its own transfer path — rather than raising the composer caps for
   one media type.
