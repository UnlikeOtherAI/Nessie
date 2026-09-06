# Nessie as an MCP server — agent access to boards and documents

Nessie today is an MCP **client**: `/api/mcp/*` manages third-party connectors
it calls out to. Nothing lets an outside agent call *in*. This adds that — a
Model Context Protocol server exposing Nessie's own surfaces, starting with
boards and documents, behind a credential any Claude or Codex agent can obtain
without a human pasting a session token out of devtools.

## Why not the surfaces we already have

Three existing things look like answers and are not:

- **`/api/mcp/*`** is connector management (catalog, instances, OAuth to other
  people's servers). Opposite direction.
- **The session JWT** is a 15-minute browser credential refreshed by a cookie
  and scoped to everything its holder can do. A headless agent cannot run that
  refresh, and handing one over grants the whole product, not a slice of it.
- **The legacy JSON-RPC `/mcp`** was deleted with the rest of `src/`. The path
  is free, which is why the new endpoint takes it rather than nesting under
  `/api/mcp/` and colliding with connector management.

## Auth

### The shape, and why

The credential mirrors `VoiceDeviceCredential`
(`api/src/services/voice/voice-device-credential.ts`) deliberately — that is
this codebase's established answer to "a non-browser client needs a scoped,
revocable credential", and a second shape would be a second thing to reason
about:

- an opaque token, prefix `nag1_`, random 32 bytes, **SHA-256 at rest** with a
  unique index on the hash;
- recognised by prefix in `registerGlobalAuthHook`, verified by its own
  verifier, and **refused with a specific 403 anywhere outside its scope** —
  presenting it on a normal API route is not a partial success to retry;
- carrying the granting human's `organizationId` / `userId` / `projectId` /
  `teamId` **and their `tokenVersion`**, so a forced sign-out or password
  change kills every agent credential that human minted, at the same instant it
  kills their browser sessions;
- expiring (90 days default), rotatable, with `lastUsedAt` so an operator can
  see which agents are live and revoke one.

The credential is **never an identity of its own**. It names a human, and every
tool call runs as that human: the actor context it resolves is the same shape
`authenticateRequest` builds, the role is re-read live from
`OrganizationMember`, and the tools call the same service functions the HTTP
routes call. An agent therefore cannot reach anything its granting human could
not reach by clicking, which is the rule
`docs/standards/personal-assistant-tools.md` already states for PA tools.

### Getting one: RFC 8628 device authorization grant

A CLI agent has no browser it controls and no callback URL. The device grant is
the standard built for exactly that, and both Claude Code and Codex can drive
it with two plain HTTP calls:

1. `POST /mcp/auth/device` → `{ device_code, user_code, verification_uri,
   verification_uri_complete, interval, expires_in }`. The agent prints the URI
   and the short `user_code`.
2. The human opens it while signed in to the admin, sees **which agent, which
   scopes, which workspace**, and approves or refuses.
3. `POST /mcp/auth/token` (polled at `interval`, honouring
   `authorization_pending` / `slow_down` / `expired_token` / `access_denied`)
   → the `nag1_` credential.

Why a human step at all: the credential inherits a person's entitlements, so a
person has to choose to lend them. Nothing here mints access from nothing.

Pairing state lives in `AgentAuthorizationRequest` — device code hashed at rest
like the credential, a user code from an unambiguous alphabet (no `O`/`0`,
`I`/`1`), 10-minute expiry, single use, and per-IP rate limiting on both the
start and the poll through the existing limiter.

### Discovery: RFC 9728

`/.well-known/oauth-protected-resource` advertises the resource and its
supported schemes, so an MCP client that speaks the spec's auth discovery finds
its way in instead of failing with an opaque 401. Nessie already publishes a
Client ID Metadata Document as an OAuth *client*
(`api/src/routes/well-known-oauth-client.ts`); this is the mirror of that on
the resource side.

Full OAuth 2.1 authorization-code + PKCE is a deliberate **later** step. It
buys browser-based clients a nicer first run; it does not help the headless
case, which is the one that blocks agents today, and it is a much larger
surface to get right. The device grant is a standard, not a stopgap.

### Scopes

Coarse and capability-shaped, because a scope nobody can explain is a scope
nobody sets correctly:

| Scope | Grants |
| --- | --- |
| `boards:read` | list projects/boards/columns, read and search tasks |
| `boards:write` | create, update, move, assign tasks |
| `documents:read` | list spaces, read and search pages |
| `documents:write` | create, update, publish, move pages |

Enforced at the tool boundary **and** underneath by the service functions'
own authorization. The scope narrows; it never widens.

## The tools

Tools are named `nessie_<surface>_<verb>`. Every one is a thin adapter over the
function the corresponding route calls — no second implementation of the rules.

### Boards

A board is a board whether its tasks originate here or in Linear. Linear-backed
boards are **mirrored into native `Task` rows** through `BoardSource` and
`TaskExternalLink`, so one tool set covers both and no `nessie_linear_*` family
exists. What does differ is writes: `BoardSource.writeMode` defaults to
`read_only`, and a write to a mirrored task on a read-only source must be
refused **in words** — "this board mirrors Linear and is read-only here; change
it in Linear" — rather than silently succeeding locally and being overwritten
by the next sync. That refusal is the interesting part of the design.

| Tool | Scope |
| --- | --- |
| `nessie_board_list` | `boards:read` |
| `nessie_board_get` | `boards:read` |
| `nessie_task_search` | `boards:read` |
| `nessie_task_get` | `boards:read` |
| `nessie_task_create` | `boards:write` |
| `nessie_task_update` | `boards:write` |
| `nessie_task_move` | `boards:write` |

Each task result carries its `source` (`internal` or the provider) and, when
mirrored, whether writes propagate — so the agent knows before it tries.

### Documents

| Tool | Scope |
| --- | --- |
| `nessie_space_list` | `documents:read` |
| `nessie_doc_list` | `documents:read` |
| `nessie_doc_get` | `documents:read` |
| `nessie_doc_search` | `documents:read` |
| `nessie_doc_create` | `documents:write` |
| `nessie_doc_update` | `documents:write` |
| `nessie_doc_publish` | `documents:write` |

`nessie_doc_search` uses the existing embedding-backed search, which already
fails closed on anything carrying a disclosure basis — so an agent cannot
retrieve through search what its human could not read directly.

## Deliberately not in the first cut

Chat, channels, runs and agent management. The request was boards and
documents, and every surface added here is a surface to keep authorized
correctly.

## Transport

Streamable HTTP at `POST /mcp`, the current MCP transport, using the SDK
already vendored for the client side (`@modelcontextprotocol/sdk`). Stateless
per request: each call authenticates its own bearer, so there is no session to
pin to a replica — which is what keeps this compatible with the horizontal
scaling work rather than quietly reintroducing sticky state.
