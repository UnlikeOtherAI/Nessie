# `@nessie/mcp-client`

Universal Model Context Protocol client for Nessie.

Wraps the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) with a small, transport-agnostic surface:

- `stdio` — spawn an MCP server as a child process
- `http` — Streamable HTTP transport (current spec)
- `sse` — legacy Server-Sent Events transport

The package is **transport-and-protocol only**: it accepts a fully-resolved connection spec and never touches the database, the secret resolver, or any other Nessie package. **Credential resolution is the caller's responsibility**, which lets this client be reused by the API server, the worker, the CLI, and tests without dragging in shared state.

## Public API

```ts
import { McpClientManager } from '@nessie/mcp-client'

const mgr = new McpClientManager()

const id = await mgr.open({ transport: 'http', url: 'https://example.com/mcp' })

const tools = await mgr.listTools(id)        // cached for 5 min
const fresh = await mgr.refresh(id)          // bypass the cache

const result = await mgr.callTool(id, 'echo',
  { message: 'hi' },
  { timeoutMs: 5_000, abort: ctrl.signal },
)

const health = await mgr.health(id)
const off    = mgr.on('state', (e) => console.log(e.state))

await mgr.close(id)
```

### Errors

Every thrown error is an instance of `McpError` with a typed `kind`:

| `kind`          | Subclass                | When                                                |
|-----------------|-------------------------|-----------------------------------------------------|
| `TIMEOUT`       | `McpTimeoutError`       | `callTool` exceeded `timeoutMs`                     |
| `TRANSPORT`     | `McpTransportError`     | socket/process died, parse failures, generic errors |
| `PROTOCOL`      | `McpProtocolError`      | malformed JSON-RPC, unknown method                  |
| `AUTH`          | `McpAuthError`          | HTTP 401/403 from the server                        |
| `NOT_CONNECTED` | `McpNotConnectedError`  | unknown connection id, closed/failed state          |

### Reconnects

`McpClientManager.reconnect(id)` retries with exponential backoff and jitter, capped at 30 s, bounded by `maxAttempts` (default 6). When the budget is exhausted the connection is marked `failed` and the caller must `open()` a new one — we never silently keep a dead pin alive.

## Composing with Nessie credentials

Credentials live in `packages/runtime`'s secret resolver. Resolve them once at the call site and pass the rendered headers / env down — the client never sees the secret ref.

```ts
import { McpClientManager } from '@nessie/mcp-client'
import { resolveCredential } from '@nessie/runtime' // illustrative

async function openLinearMcp(userId: string): Promise<void> {
  const cred = await resolveCredential({
    instanceId: 'linear-prod',
    principalType: 'user',
    principalId: userId,
  }) // → { headerName: 'Authorization', value: 'Bearer ey...' }

  const mgr = new McpClientManager()
  const id = await mgr.open({
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: { [cred.headerName]: cred.value },
  })
  // ...mgr.callTool(id, ...)
}
```

For stdio servers the same pattern applies — resolve secrets to plain env vars, then pass `env: { ...resolved }` into the spec.

## Testing

```sh
pnpm --filter @nessie/mcp-client test
```

Tests boot a local fake MCP server (`test/fake-server.ts` + `test/stdio-fake-server.ts`) for stdio, streamable HTTP, and SSE transports, and cover open/list/call/close, cache + refresh, timeouts, abort, reconnect, and typed error discriminants.
