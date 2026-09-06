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

`/.well-known/oauth-protected-resource` describes the resource, and the 401 from
`POST /mcp` carries a `WWW-Authenticate` challenge pointing at it — which is
what turns an opaque refusal into something a client can act on.

The document says plainly that **no authorization server runs here** and names
the device-authorization endpoints instead. Advertising an `authorization_servers`
list this deployment cannot honour would fail later and less legibly than
telling the truth up front.

Full OAuth 2.1 authorization-code + PKCE is a deliberate **later** step. It
buys browser-based clients a nicer first run; it does not help the headless
case, which is the one that blocks agents today, and it is a much larger
surface to get right. The device grant is a standard, not a stopgap.

### Scopes

Coarse and capability-shaped, because a scope nobody can explain is a scope
nobody sets correctly:

| Scope | Grants |
| --- | --- |
| `boards_read` | list projects/boards/columns, read tasks |
| `boards_write` | create, update and move tasks |
| `documents_read` | list spaces, read pages |
| `documents_write` | create and edit pages, as drafts |
| `documents_publish` | publish a draft |

`documents_publish` is separated from `documents_write` deliberately, and is the
one scope the approval screen does **not** pre-tick. "Agents draft; only a human
may publish" is a rule this product enforces for its own agents by refusing an
`agent` actor outright — and an MCP credential resolves as the human who
approved it, so that check does not catch it. Rather than drop the rule or
refuse publication forever, the decision stays human and moves to pairing time:
a person ticks a box that says this agent may publish, once, and can revoke it.

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
| `nessie_task_get` | `boards:read` |
| `nessie_task_create` | `boards:write` |
| `nessie_task_update` | `boards:write` |
| `nessie_task_move` | `boards:write` |

Each task result carries its `origin` (`internal` or the provider) and, when
mirrored, whether writes propagate — so the agent knows before it tries.

The refusal itself comes from the platform, not from these tools. The mutating
services already take the board-source write-back collaborator, and it answers
better than anything composed here could: *"Linear owns this ticket. Switch the
source to read & write in Settings → Sources to change it from here."* The tool
passes that through and adds only whether retrying could ever help — `false` for
a read-only source, `true` for an unreachable provider.

### Documents

| Tool | Scope |
| --- | --- |
| `nessie_space_list` | `documents:read` |
| `nessie_doc_list` | `documents:read` |
| `nessie_doc_get` | `documents:read` |
| `nessie_doc_create` | `documents:write` |
| `nessie_doc_update` | `documents:write` |

**There is no publish tool, deliberately.** The HTTP route refuses publication
outright for an agent actor — "agents draft; only a human may publish" — and
sends them to an approval instead. An agent credential resolves as the human who
approved it, so a publish tool here would walk straight past a gate written for
exactly this kind of caller. Drafting and editing are the useful writes;
publication stays a human act, and `nessie_doc_create` therefore always produces
a draft.

`nessie_doc_update` accepts the `expectedRevision` the agent read. Supplying it
turns a stale edit into a refusal the agent can act on rather than a silent
last-write-wins — the same choice the auto-saving editor gives a person.

Writes are audited as the granting human with `via: 'mcp_agent_credential'`, so
the log can tell a person's own edit from one their agent made for them.

Publishing is `nessie_doc_publish`, behind its own scope (above).

`nessie_doc_search` is not in this cut. It would need the embedding-backed
search path, which fails closed on anything carrying a disclosure basis; worth
having, but a larger surface than the CRUD above.

### The identity a credential carries

A credential stores the approving human's `uoaIdentity` and replays it into the
actor context, exactly as a scheduled trigger replays `launchOrigin.uoaIdentity`
and for the same reason: **work an agent starts can outlive the call.** Creating
a document enqueues an embedding job, and on a signing deployment that job's
Ledger call needs the originating person's UOA workspace — which the account
link cannot supply, because it proves subject, status and epoch but not which
workspace they were acting in.

Without it the tool reports success and the indexing fails later, in the
background, where nobody is looking. So a signing deployment refuses to grant
document scopes to a session carrying no UOA identity, while there is still
somebody to tell — the same refusal the scheduled-trigger create route makes.

## Deliberately not in the first cut

Chat, channels, runs and agent management. The request was boards and
documents, and every surface added here is a surface to keep authorized
correctly.

Also absent: document publication (above), semantic document search, board and
column administration, and task assignment. Assignment in particular writes
through to the provider and fails in its own way — `ASSIGNEE_NOT_LINKED` when
the person has no account on the other side — which deserves its own thought
rather than being tacked on.

## Transport

Streamable HTTP at `POST /mcp`, the current MCP transport, using the SDK
already vendored for the client side (`@modelcontextprotocol/sdk`). Stateless
per request: each call authenticates its own bearer, so there is no session to
pin to a replica — which is what keeps this compatible with the horizontal
scaling work rather than quietly reintroducing sticky state.
