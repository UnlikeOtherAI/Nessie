# Tool Registry and Capability Model

> Status: target-state design. Phase 3.

## 1) Objective

Provide a single capability system where:

- every available tool is registered in a central registry,
- tools can be imported from one-file manifests without code changes,
- roles define inherited tool defaults,
- each managed agent can override inherited tool permissions and runtime config,
- UI renders this as checkboxes (allow/deny) plus optional per-tool config overrides,
- prompt layers compose independently from tool schemas,
- execution enforcement blocks denied tools before invocation.

This document consolidates the target model from `docs/agent tool capabilities/` chapters 01-03 into a single Phase 3 implementation spec.

## 2) Current gap

Current behavior is static:

- tool list lives as hardcoded `allTools`,
- role permissions are hardcoded in `ROLE_POLICIES`,
- managed agents only store `tools: string[]`,
- no per-agent tool override or tool registration API,
- no persisted tool config per agent/tool,
- no manifest import mechanism,
- no prompt inheritance model.

## 3) Data model

### 3.1 Prisma models

```prisma
model ToolRegistryEntry {
  id              String   @id @default(uuid())
  toolName        String
  label           String
  overview        String
  instructions    String   @default("")
  source          String   // 'builtin' | 'custom' | 'mcp-remote' | 'interactive-session'
  transport       String   // 'direct' | 'mcp' | 'stdio' | 'http' | 'pty'
  transportConfig Json     @default("{}")
  inputSchema     Json
  outputSchema    Json?
  tags            String[]
  baseSearchTerms String[]
  allowSearchTerms String[]
  basePrompt      Json     // { content: string, mergeMode: 'append' | 'prepend' | 'replace' }
  commonPrompt    Json?    // { enabledPrompt, overviewPrompt?, blockedPrompt?, overrideMode }
  defaultConfig   Json     @default("{}")
  enabled         Boolean  @default(true)
  createdBy       String   // 'system' | 'role' | 'agent'
  owner           String
  bundleId        String?
  organizationId  String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  organization    Organization @relation(fields: [organizationId], references: [id])
  grants          ToolGrant[]

  @@unique([organizationId, toolName])
  @@index([organizationId, source])
  @@index([organizationId, tags], type: Gin)
  @@index([updatedAt])
}

model ToolGrant {
  id        String   @id @default(uuid())
  toolId    String
  state     String   // 'inherit' | 'allowed' | 'denied'
  config    Json     @default("{}")
  source    String   // 'role' | 'agent-override'
  roleId    String?
  agentId   String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tool      ToolRegistryEntry @relation(fields: [toolId], references: [id], onDelete: Cascade)

  @@unique([toolId, roleId, agentId])
  @@index([roleId])
  @@index([agentId])
}

model ToolBundle {
  id            String   @id @default(uuid())
  apiVersion    String   // 'toolset.nessie.io/v1'
  bundleName    String
  version       String
  vendor        String?
  sourceUrl     String?
  license       String?
  signatureType String?
  signatureValue String?
  policy        Json     @default("{}")
  status        String   @default("pending_review") // 'pending_review' | 'approved' | 'rejected' | 'disabled'
  importedBy    String
  organizationId String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  organization  Organization @relation(fields: [organizationId], references: [id])

  @@unique([organizationId, bundleName, version])
}

model PromptLayer {
  id        String   @id @default(uuid())
  type      String   // 'global' | 'role' | 'agent' | 'task' | 'tool-call'
  content   String
  priority  Int
  mergeMode String   // 'append' | 'prepend' | 'replace'
  locked    Boolean  @default(false)
  roleId    String?
  agentId   String?
  toolId    String?
  organizationId String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId, type])
  @@index([agentId])
  @@index([roleId])
}
```

### 3.2 TypeScript types (for `packages/schemas`)

```ts
type ToolId = string & { readonly __brand: 'ToolId' };
type ToolBundleId = string & { readonly __brand: 'ToolBundleId' };
type ToolGrantId = string & { readonly __brand: 'ToolGrantId' };
type PromptLayerId = string & { readonly __brand: 'PromptLayerId' };

type ToolSource = 'builtin' | 'custom' | 'mcp-remote' | 'interactive-session';
type ToolTransport = 'direct' | 'mcp' | 'stdio' | 'http' | 'pty';
type ToolGrantState = 'inherit' | 'allowed' | 'denied';
type ToolGrantSource = 'role' | 'agent-override';
type ToolBundleStatus = 'pending_review' | 'approved' | 'rejected' | 'disabled';
type PromptLayerType = 'global' | 'role' | 'agent' | 'task' | 'tool-call';
type PromptMergeMode = 'append' | 'prepend' | 'replace';

type ToolCapabilitySchema = {
  id: ToolId;
  toolName: string;
  label: string;
  overview: string;
  instructions: string;
  source: ToolSource;
  transport: ToolTransport;
  transportConfig: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tags: string[];
  baseSearchTerms: string[];
  allowSearchTerms: string[];
  basePrompt: {
    content: string;
    mergeMode: PromptMergeMode;
  };
  commonPrompt?: {
    enabledPrompt: string;
    overviewPrompt?: string;
    blockedPrompt?: string;
    overrideMode: PromptMergeMode;
  };
  defaultConfig: Record<string, unknown>;
  enabled: boolean;
  createdBy: 'system' | 'role' | 'agent';
  owner: string;
  bundleId?: ToolBundleId;
};

type ToolRuntimeConfig = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  workingDirectory?: string;
  retries?: number;
  requireApproval?: boolean;
  allowDestructive?: boolean;
  [key: string]: unknown;
};

type ToolGrantRecord = {
  id: ToolGrantId;
  toolId: ToolId;
  state: ToolGrantState;
  config: Record<string, unknown>;
  source: ToolGrantSource;
  roleId?: string;
  agentId?: string;
};

type EffectiveToolGrant = {
  toolId: ToolId;
  toolName: string;
  label: string;
  state: ToolGrantState;
  config: Record<string, unknown>;
  source: ToolGrantSource;
  inherited: boolean;
};

type ToolSearchDocument = {
  id: ToolId;
  label: string;
  overview: string;
  instructions: string;
  tags: string[];
  basePrompt: {
    content: string;
    mergeMode: PromptMergeMode;
  };
  source: ToolSource;
  transport: ToolTransport;
  allowed: boolean;
  owner: string;
  createdBy: 'system' | 'role' | 'agent';
  version: string;
  updatedAt: string;
  searchableText: string;
};

type ToolSearchResult = {
  items: ToolSearchDocument[];
  total: number;
  filtered: number;
  page: number;
  pageSize: number;
  cursor?: string;
  etag: string;
};
```

### 3.3 Permission and override model

```ts
type AgentToolOverrides = {
  mode: 'inherit' | 'custom';
  grants: Record<string, Omit<ToolGrantRecord, 'id' | 'source'>>;
};
```

Effective policy resolution:

```ts
effectiveToolPolicy(agent, rolePolicy) =
  merge(rolePolicy.grants, agent.toolPolicy?.grants, source='agent-override')
```

- inherited values apply first,
- agent overrides replace inherited state/config when present,
- explicit `state: 'denied'` blocks a role default,
- explicit `state: 'inherit'` keeps the parent decision without creating a deny.

### 3.4 Agent execution loop policy

Provider/model choice and loop strategy must be part of agent configuration, not hidden prompt behavior. See `docs/agent tool capabilities/01-foundations.md` section 3.4a for the full `executionPolicy` schema with multi-stage parallelism, aggregation, and orchestrator configuration.

Key rules:

- each stage can fan out into multiple parallel candidates,
- each stage can aggregate candidates and select one best result,
- the runtime must enforce a hard cap (`maxTotalRuns`) to control cost and runaway loops,
- evaluation/refinement metadata should be auditable as part of the task ledger.

## 4) Tool manifest and import

### 4.1 NessieToolBundle manifest format

One file carries all metadata needed to onboard a new tool. No code edits required.

Supported file forms:

- `toolset.json`
- `toolset.yaml` / `toolset.yml`
- `toolset.md` with YAML frontmatter

Manifest schema:

```ts
type NessieToolBundle = {
  apiVersion: 'toolset.nessie.io/v1';
  kind: 'NessieToolBundle';
  metadata: {
    id: string;
    name: string;
    version: string;
    vendor?: string;
    source?: string;
    license?: string;
    signature?: {
      type: 'sha256' | 'ed25519';
      value: string;
    };
  };
  policy?: {
    defaultToolMode: ToolGrantState;
    defaultSandbox?: {
      allowOutsideReadOnly?: boolean;
      allowedRoots?: string[];
      deniedPaths?: string[];
      env?: {
        allowVars?: string[];
        denyVars?: string[];
      };
    };
  };
  tools: Array<{
    id: string;
    toolName: string;
    label: string;
    overview: string;
    instructions?: string;
    source: ToolSource;
    transport: ToolTransport;
    transportConfig?: Record<string, unknown>;
    inputSchema: Record<string, unknown>;
    enabled?: boolean;
    grants?: {
      allowed: boolean;
      config?: Record<string, unknown>;
    };
    basePrompt?: {
      content: string;
      mergeMode: PromptMergeMode;
    };
    commonPrompt?: {
      enabledPrompt: string;
      overrideMode: PromptMergeMode;
    };
    tags?: string[];
    baseSearchTerms?: string[];
    allowSearchTerms?: string[];
    createdBy?: 'system' | 'role' | 'agent';
    owner?: string;
  }>;
};
```

### 4.2 Import mechanism

- **Local:** copy one file into a configured import path. Backend validates schema + signature + policy constraints. Writes to the tool registry.
- **Marketplace:** fetch artifact from signed package manifest. Verify checksum/signature before import.
- **UI:** prompt a review diff (tools, permissions, sandbox deltas). Default action is "disabled until approved".

### 4.3 Marketplace index entry

```ts
type ToolsetIndexEntry = {
  schema: 'toolset-index.nessie.io/v1';
  items: Array<{
    name: string;
    manifestUrl: string;
    checksum: string;
    signature?: {
      type: string;
      value: string;
    };
    license?: string;
  }>;
};
```

## 5) Search and discovery

### 5.1 Search behavior

Default order: `updatedAt DESC, source ASC, label ASC, id ASC` unless caller provides an explicit `sort`.

Pagination uses opaque `cursor` where `cursor` maps to a stable `(updatedAt, id)` boundary. Ties always use lexical `id` so identical filter/sort inputs are replayable.

### 5.2 Discovery query parameters

- `q` (full-text)
- `tags` filter (multi-value)
- `scope` (`agent`, `task`, `global`, `mcp`, `custom`, `builtin`, `interactive`)
- `state` (`enabled` / `disabled`)
- `source` and `transport` filters
- optional `limit` (<=100, default 25)
- optional `cursor`
- optional `sort`

### 5.3 Searchable text derivation

`searchableText` is derived at write time from:

- `overview` + `instructions` + `basePrompt.content` + `tags` + `baseSearchTerms` + `allowSearchTerms`

This field is indexed for full-text search. It is not stored as user-visible content.

## 6) Prompt inheritance and override model

### 6.1 PromptLayer type

```ts
type PromptLayer = {
  id: PromptLayerId;
  type: PromptLayerType;
  content: string;
  priority: number;
  mergeMode: PromptMergeMode;
  locked?: boolean;
};

type PromptProfile = {
  commonPrompt: string;
  deniedPrompt?: string;
  allowedPrompt?: string;
  inherit?: string[];
  layers?: PromptLayer[];
  defaults: Record<string, unknown>;
};

type ManagedAgentProfile = {
  systemPrompt: string;
  userPrompt: string;
  toolPrompt: PromptProfile;
  rolePrompt?: PromptProfile;
  subAgentPrompt?: PromptProfile;
  toolOverrides?: Record<string, PromptProfile>;
  subAgents?: string[];
};
```

### 6.2 Prompt resolution order

For a given execution, prompts resolve in this order:

1. global role/default prompt
2. agent prompt (including sub-agent variants)
3. task-specific prompt
4. tool prompt layer
5. per-tool override
6. call-level override from explicit user input (if approved by approval gate)

Rules:

- tool-level override can replace or append to inherited prompt,
- agent-level override can add prompts for all child sub-agents unless the child sets `inheritPrompt = false`,
- `locked: true` prevents lower-priority layers from replacing.

## 7) MCP registry sync

- Keep MCP tool list as a projection of the registry.
- MCP tool definitions auto-generated from catalog entries when `transport` is `mcp` or when custom wrappers are exposed.
- Agent-level MCP access must be explicit through `mcpPolicy.allowedServers`; the registry must not expose unapproved servers to agents.
- Static built-ins are first-class entries in the catalog.
- Add versioned cache + `list`/`search` response metadata: `total`, `filtered`, `cursor`, `etag`.

## 8) Execution enforcement

Before calling any tool:

1. Resolve effective grant for the agent/task context.
2. Deny if `state !== 'allowed'` (after inheritance resolution).
3. Apply effective config over tool defaults.
4. Check sandbox constraints from bundle policy.
5. Execute with merged config.
6. Validate output if schema exists.
7. Emit audit event.

Enforcement points:

- `spawnSubAgent` tool selection,
- MCP `invoke_tool` / `callTool` path,
- any direct tool-call flow.

## 9) API contracts

All endpoints use `/api/` prefix per [hosted-app-architecture.md](./hosted-app-architecture.md) section 13.

### 9.1 Tool registry endpoints

- `GET /api/tools` — list all tool registry entries + schema metadata. Supports discovery query params (section 5.2).
- `GET /api/tools/{toolId}` — get single tool entry.
- `POST /api/tools` — register custom tool metadata and schema descriptor.
- `PATCH /api/tools/{toolId}` — update tool metadata.
- `DELETE /api/tools/{toolId}` — unregister (if permitted by policy).
- `POST /api/tools/search` — full-text search with filters and pagination.

### 9.2 Tool grant endpoints

- `GET /api/roles/{roleId}/tools` — inherited role tool grants.
- `GET /api/agents/{agentId}/tools` — effective tool grants for that agent.
- `PATCH /api/agents/{agentId}/tools/{toolId}` — set agent override.
  - `mode: "inherit"` clears agent overrides.
  - `mode: "custom"` stores agent overrides.

### 9.3 Bundle import endpoints

- `POST /api/tools/bundles/import` — import a NessieToolBundle manifest. Validates schema, signature, policy. Creates tools in `pending_review` state.
- `GET /api/tools/bundles` — list imported bundles.
- `GET /api/tools/bundles/{bundleId}` — get bundle details.
- `POST /api/tools/bundles/{bundleId}/approve` — approve bundle (tools become enabled).
- `POST /api/tools/bundles/{bundleId}/reject` — reject bundle.

### 9.4 Prompt layer endpoints

- `GET /api/prompts` — list prompt layers. Filterable by `type`, `roleId`, `agentId`, `toolId`.
- `GET /api/prompts/{promptId}` — get single prompt layer.
- `POST /api/prompts` — create prompt layer.
- `PATCH /api/prompts/{promptId}` — update prompt layer.
- `DELETE /api/prompts/{promptId}` — delete prompt layer.
- `GET /api/agents/{agentId}/prompts/effective` — resolved prompt chain for an agent.

## 10) MCP parity

Control actions with matching MCP names:

- `tools.list`, `tools.get`, `tools.create`, `tools.update`, `tools.delete`, `tools.search`
- `tools.grants.role.list`, `tools.grants.agent.list`, `tools.grants.agent.update`
- `tools.bundles.import`, `tools.bundles.list`, `tools.bundles.get`, `tools.bundles.approve`, `tools.bundles.reject`
- `prompts.list`, `prompts.get`, `prompts.create`, `prompts.update`, `prompts.delete`
- `prompts.effective`

## 11) UI behavior

### 11.1 Tool checkbox matrix

Each row = one tool:

- checkbox = effective `allowed`,
- inherited badge shown when value comes from role,
- override toggle switches row into editable mode,
- expanded "options" panel for config (e.g., timeout, retries, cwd),
- "reset to role default" clears overrides.

### 11.2 Bundle import review

- prompt a review diff (tools, permissions, sandbox deltas),
- default action is "disabled until approved",
- show signature verification status.

### 11.3 Prompt editor

- base prompt (read-only),
- override editor per row,
- inheritance chain toggle,
- preview of resolved prompt for a given agent/tool combination.

## 12) Audit integration

All tool registry mutations, grant changes, bundle imports, and prompt changes must emit audit events through the audit trail system (see [audit-trail-spec.md](./audit-trail-spec.md)).

Audited actions:

- `tool.created`, `tool.updated`, `tool.deleted`
- `tool.grant.updated` (role or agent level)
- `tool.bundle.imported`, `tool.bundle.approved`, `tool.bundle.rejected`
- `tool.execution.denied` (enforcement blocked a call)
- `prompt.created`, `prompt.updated`, `prompt.deleted`

## 13) Security

- tool configs must accept arbitrary JSON but sandbox constraints from bundle policy are enforced before execution,
- `transportConfig` must not contain secrets in plaintext; use `secretRef` from [secret-management-spec.md](./secret-management-spec.md),
- bundle signatures must be verified before tools are made available,
- denied tools must return structured deny reason codes: `TOOL_NOT_FOUND`, `TOOL_DENIED`, `TOOL_DISABLED`, `SANDBOX_VIOLATION`, `POLICY_DENY`,
- no tool execution output is included in audit events (only metadata and success/failure).

## 14) Phase annotation

This spec targets **Phase 3**. Dependencies:

- Phase 2 policy enforcement engine must exist for grant evaluation,
- Phase 2 audit trail must exist for event emission,
- Phase 1 agent model exists as the foundation.

## 15) Cross-links

- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [config-module-spec.md](./config-module-spec.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [implementation-phases.md](./implementation-phases.md)
- [functionality.md](./functionality.md)
