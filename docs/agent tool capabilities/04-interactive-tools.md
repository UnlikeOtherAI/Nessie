# Interactive Tooling and Sessions

## 11) Interactive process tooling (Codex / Claude / local CLI sessions)

Current `Bash` executes one-shot commands only. For interactive control sessions the control plane should add:

1. `session:start`
   - command + args + cwd + env + pty flag
   - returns `sessionId`, pid, pid metadata
2. `session:read`
   - `sessionId`, `maxBytes`, `cursor`, `timeoutMs`
   - returns incrementally appended stdout/stderr chunks
3. `session:send`
   - send bytes/text to stdin
4. `session:interrupt`
   - send SIGINT / SIGTERM / SIGKILL
5. `session:status`
   - exit code, runtime, resource usage, current state
6. `session:close`
   - terminate and optionally persist transcript

CLI wrappers included by default in toolset policy:

- `codex`
- `claude`
- `gemma`
- `ollama`
- any other local tool should be imported from toolset manifests and validated before enablement.

Design rule:
- interactive sessions are long-lived stateful resources and must not be implemented as direct `Bash` args.
- one session = one process with resource limits and tool-sandbox policy.
- default sandbox applies to session cwd and file access for all subsequent `session:*` operations.

Minimal shell-level example intent:
- `session:start` with `{ command: "claude", args: ["-p"], cwd: "/repo" }`
- repeated `session:send` with incremental prompts to drive a coding session.

### 11.1) SSH single-entry tool profile (`toolId: "ssh"`)

Add one registry entry for remote machine operations:

- `id`: `"ssh"`
- `toolName`: `"SSH"`
- `label`: `"SSH"`
- `overview`: `"Execute a remote command over SSH, or keep one interactive SSH session open for follow-up input."`
- `instructions`: `For remote execution, prefer explicit host aliasing and strict key/host allowlists. Never run sudo or destructive commands unless policy permits and approval is present.`
- `source`: `"custom"` or `"builtin"` depending on install model
- `transport`: `"pty"` or `"direct"` with wrapper-level spawn semantics (implementation may expose as session transport)
- `tags`: `["ssh", "remote", "session", "automation"]`

The SSH capability should support two behavior modes in a single tool entry:

1. Fire-and-forget mode (`mode: "run"`):
   - Inputs:
     - `host` (required),
     - `command` (required),
     - `user` (optional),
     - `port` (optional, default 22),
     - `identityKeySecretRef` (optional),
     - `knownHostsPolicy` (`strict`/`accept-new`),
     - `timeoutMs`,
     - `env`.
   - Behavior:
     - open one connection, execute command, stream exit code/stdout/stderr, close process when complete.
     - no long-lived session object is retained.

2. Interactive mode (`mode: "session"`):
   - Inputs:
     - `host` (required),
     - `command` (optional for shell),
     - `user` (optional),
     - `port` (optional, default 22),
     - `identityKeySecretRef` (optional),
     - `keepAliveMs`,
     - optional `shell` override.
   - Behavior:
     - `session:start` resolves command as `ssh` process and stores `sessionId`,
     - subsequent `session:send`, `session:read`, `session:interrupt`, `session:status`, `session:close` are used on the open session,
     - when user says done, send `exit` or call `session:close`.

Policy requirements for SSH:
- one tool entry, variable behavior controlled by `mode` and `sessionContext` fields.
- all SSH actions require host allowlist (`allowedHosts`) and key policy (`allowedKeys`).
- default deny on wildcard hosts.
- execution context must include:
  - `actorId`,
  - `teamId`,
  - `channelId`,
  - `threadId`.

Suggested `toolConfig` payload shape:

```ts
type SSHToolConfig = {
  mode: 'run' | 'session';
  host: string;
  user?: string;
  port?: number;
  command?: string;
  workingDir?: string;
  identityKeySecretRef?: string;
  knownHostsPolicy?: 'strict' | 'accept-new';
  timeoutMs?: number;
  keepAliveMs?: number;
  env?: Record<string, string>;
  allowList?: {
    allowedHosts?: string[];
    deniedHosts?: string[];
    allowedKeys?: string[];
  };
};
```

This keeps SSH as a single declarative tool while supporting both “do and close” and “open persistent session” operator modes.

### 11.2) Knowledge base tool for external docs/folders (RAG-ready retrieval)

Goal: make external docs usable without blowing context.

Recommended implementation model: "retrieval + summarization first", then optional synthesis on explicit request.

- One `knowledge-base` tool family (single capability surface) that supports:
  - `link`: add source (folder path, MCP doc endpoint, URL, file path).
  - `reindex`: crawl and refresh metadata/chunks.
  - `summarize`: produce short source-level summary metadata on ingest.
  - `search`: deterministic + semantic lookup.
  - `read`: fetch full content by item key.
  - `search.summary`: compact answer with citations and source IDs.

- Source model:
  - local folder,
  - MCP docs endpoint (JSON/Markdown),
  - single documents,
  - remote URLs (with allowlist and fetch policy).

- Ingestion metadata per item:
  - `sourceUri`, `kind`, `mimeType`, `title`, `summary`, `language`, `tags`, `updatedAt`, `checksum`.
- Deterministic index (must exist for each query):
  - exact-match by tags, extension, source, path/team,
  - source/project-scoped indexes for isolation by project
  - lexical path/title sort fallback,
  - stable cursor.
- Ephemeral index for the current thread:
  - short-lived shortlist built from user query context,
  - bounded to N latest hits and TTL,
  - optional opt-in for temporary session-only context.
- Deterministic mode:
  - sort and cursor stable by default (`updatedAt DESC, docId ASC` fallback),
  - explicit ranking mode for semantic lookup.
- Search behavior:
  - always return at most `k` ranked items + compact snippets,
  - never auto-include full docs in tool context unless `read` called,
  - default response should be structured `docId`, `title`, `summary`, `location`, `score`, `sourceType`,
  - include provenance links (`team/channel` visibility and policy reason).
- This is not “full RAG generation”; it is retrieval + summarization on demand.  
  - Full text synthesis happens only when a sub-agent calls `read` (and is scoped by policy).
- Governance:
  - per-team/channel source allowlist,
  - per-project source allowlist and namespace boundary,
  - source-level roles (`read` vs `search` vs `summarize` vs `reindex`),
  - audit log for each `search`, `read`, `reindex`.

Cross-link:
- [knowledge-base-requirements.md](./../knowledge-base-requirements.md) for implementation decision framing and acceptance criteria.

Recommended tool shape:

```ts
type KnowledgeBaseToolActions = {
  action: "link" | "reindex" | "search" | "search.summary" | "read" | "summarize";
  sourceUri?: string;
  sourceType?: "folder" | "file" | "url" | "mcp";
  projectId?: string;
  query?: string;
  topK?: number;
  tags?: string[];
  scope?: "public" | "protected" | "private";
  ephemeral?: boolean;
  docId?: string;
};
```

### 11.3) Slack-style routing and point-of-view control

To keep chat useful as the number of agents grows, the model needs a routing layer between user messages and worker agents.

- Add explicit channel routing config:
  - `channelId`, `name`, `permissions`, `defaultResponderMode`.
- Add hidden organizer roles per scope:
  - `orchestrator`, `channel`, `web`, and any future channels.
  - organizer receives raw message first and emits exactly one visible answer unless explicit broadcast is requested.
- Add deterministic candidate selection:
  - policy match,
  - confidence score on agent fit,
  - resource/load health.
- Keep "private thinking" by default:
  - organizers may collect `agent.pointOfView` payloads,
  - user-visible merge remains one response unless `show all` or `all viewpoints` is requested.
- Preserve deep delegation:
  - `parentAgentId`/`subAgents` should be explicit in agent objects,
  - routing must work across at least three levels deep when explicitly addressed.
- Add routing events in state stream:
  - `routing.started`, `routing.decision`, `routing.trace`,
  - `agent.pointOfView` for optional reveal mode.

Required minimum UX behavior:
- explicit `@agent` and `@channel` addressing,
- implicit messages routed through organizer for one visible answer,
- `@all` or `broadcast` triggers full fan-out with explicit trace for audit.

JSON-extensible config requirement for command/CLI session tools:
- Tool configs must accept arbitrary keys (`Record<string, unknown>`) so wrappers can evolve without requiring schema churn.
- Include at least:
  - `command: string`
  - `args: string[]`
  - `workdir: string`
  - `env: Record<string, string>`
  - `modelFlag: string` (e.g. `--model` / `-m`)
  - `pty: boolean`
  - `helpCommand: string` (e.g. `--help`, `-h`) for capability discovery.

This is the only durable way to support arbitrary CLI-based tools like Codex, Claude, and local `ollama` wrappers with future command shape changes.

### 11.4) Secret handling for tool config and runtime execution

- Contract status: target-state only. Runtime is currently missing these endpoints and enforcement checks.

Rules:

- Never store plaintext secrets in tool schemas, tool config, prompts, or registry metadata.
- Use `secretRef` IDs in tool calls and agent configs where credentials are needed.
- Secret values are resolved by backend services only at execution time and immediately redacted from:
  - chat logs,
  - event streams,
  - audit payloads (except hashed action context),
  - tool outputs unless explicitly requested.

Required API contracts:

- `POST /secrets` (create)
  - stores value + returns `{ secretRef, id, createdAt }`
- `GET /secrets` (metadata list)
- `GET /secrets/{secretRef}` (metadata only)
- `PATCH /secrets/{secretRef}` (metadata updates)
- `DELETE /secrets/{secretRef}` (delete or tombstone)
- `POST /secrets/{secretRef}/resolve` (runtime use only)
- `POST /secrets/{secretRef}/rotate`
- `POST /secrets/{secretRef}/revoke`
- `POST /secrets/{secretRef}/grants`
- `DELETE /secrets/{secretRef}/grants/{grantId}`
- `GET /secrets/{secretRef}/grants`
- `GET /secrets/audit`
- `POST /secrets/access/check`

Access model for runtime:

- evaluate deny-first over org/project/team/channel/explicit binding and tool policy,
- deny codes must be surfaced to caller:
  - `NO_SCOPE_MATCH`,
  - `DENIED_BINDING`,
  - `SECRET_NOT_FOUND`,
  - `POLICY_DENY`,
  - `SECRET_EXPIRED`,
  - `SECRET_REVOKED`,
  - `RATE_LIMITED`.

Secret runtime events:

- `secret.access_check`
- `secret.access_denied` (reason code + policy source IDs)
- `secret.resolve` (no plaintext payload)

Cross-link:
- [secret-management-spec.md](./../secret-management-spec.md) for full schema, encryption, and API details.
