# Sandboxing, Discoverability, and Governance

## 12) Path and environment sandboxing

Tool and sub-agent execution policy must include explicit filesystem constraints:

```ts
type SandboxPolicy = {
  type: 'allow-deny'
  allowOutsideReadOnly: boolean
  allowedRoots: string[]             // e.g. ["/System/Volumes/Data/Projects"]
  allowedCwd?: string[]             // command default and runtime cwd override allowlist
  deniedPaths?: string[]            // deny takes precedence
  env: {
    allowVars?: string[]            // list of vars allowed to pass through
    denyVars?: string[]             // removed regardless of caller input
    maxEnvSize?: number
  }
  io: {
    maxCommandOutputBytes?: number
    maxLogTailBytes?: number
  }
  cpuMillisPerToolCall?: number
  wallClockMillis?: number
  network?: {
    allowedHosts?: string[]
    denyHosts?: string[]
  }
}
```

- Defaults should be strict:
  - deny by default outside configured execution roots unless explicitly listed.
  - treat `write` as denied unless explicitly allowed in `allowedRoots`.
  - all external path reads must be denied or mapped read-only when `allowOutsideReadOnly = true`.
- Sandbox policy can be inherited from role, then overridden by agent, then overridden by tool call config.
- Enforcement points:
  - command/session spawn normalization
  - file read/write helper checks in tool call path
  - interactive session IO and path resolution.

## 13) Tool + agent discoverability (registry search)

Avoid loading all tools/agents at startup by supporting query endpoints and scoped selectors.

Recommended endpoints:
- `GET /tools/search?q=search&tag=session&scope=control&limit=25&cursor=...`
- `GET /tools/tags` (index for tags and counts)
- `GET /tools/search?sort=updatedAt&order=desc&scope=agent&cursor=<opaque>` for deterministic paging
- `GET /agents/search?q=weather&type=on-demand`
- `GET /mcp/resources/{resourceId}` for tool docs and policy state snapshots.

For `/tools/search`:
- `scope` means discovery scope or registry slice (`control`, `agent`, `builtin`, `custom`, etc.), not privacy visibility.
- visibility and permission filters can be layered on top of that base scope:
  - `includePrivate`,
  - `includeProtected`,
  - `visibility`,
  - `canRead`,
  - `canInvoke`,
  - `canManage`,
  - `teamId`,
  - `channelId`.

Search ranking inputs:
- `label` and `overview`
- `q` full-text over `overview`, `instructions`, and `tags`
- aliases and tag vectors
- role ownership
- transport type (`mcp`, `builtin`, `interactive`, `custom`)
- allow/deny status
- lastUsed, failure rate, cost profile.

Deterministic sort for UI/agent bootstrap:
- default: `updatedAt DESC, source ASC, label ASC, id ASC`
- tie-breaker: `id` lexical
- each response includes `total`, `filtered`, `page`, `pageSize`, `cursor`, and `etag`.

### 13.1 Minimal compliance check for current implementation

- `tools/list` returns static MCP `ToolDef` list, no query/filter/metadata.
- no `/tools/search` endpoint yet.
- no `/agents/search`; agent discovery requires reading full state.
- no control-plane `resource` endpoints for registry index beyond static resource list.

### 13.2) Organization and team governance (agent, tool, and execution scope)

Organization-scale access must be policy-driven and enforced at two execution points: routing and tool-call boundary.

- Add `Organization`, `Team`, and `Channel` entities.
- Add `ChannelType` visibility levels (`public`, `protected`, `private`).
- Add membership entities:
  - `userTeamMembership`,
  - `channelMembership`,
  - `agentTeamBinding`,
  - `agentChannelBinding`.
- Add MCP server access policy on agents:
  - `mcpPolicy.allowedServers`,
  - `mcpPolicy.deniedServers`,
  - MCP execution must fail closed when the server is not explicitly allowed.
- Add team-aware search filters:
  - `/teams/{teamId}/agents/search`,
  - `/channels/{channelId}/agents/search`,
  - `/tools/search?teamId=&channelId=`.
- Route candidate set must exclude:
  - non-members of the target team/channel,
  - callers without invoke permission,
  - tool-disallowed channels/agents in the same path.
- Multi-tag routing rule for channel messages:
  - explicit tags in one message (`@agentA @agentB`) produce a candidate set of exactly those tagged agents;
  - no untagged agents execute unless fallback is explicitly requested.
- Tool grants must still support arbitrary JSON config for CLI wrappers (e.g. `command`, `helpCommand`, `modelFlag`, `pty`, `env`).
- Deny and visibility reasons should return stable reason codes for UI guidance and logs (`teamMembershipMissing`, `channelHidden`, `toolDeny`, `scopeMismatch`).
