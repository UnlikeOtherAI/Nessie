# Conversational agent setup: contracts and invariants

The runtime contract behind the [core decisions](core-decisions.md): the
request state machine, the authorization and security invariants every path
must hold, and the contract the agent itself is held to.

See also the [overview](overview.md) and
[delivery and verification](delivery-and-verification.md).

## State machine

### Agent creation

| State | What the person sees | Allowed next action |
| --- | --- | --- |
| `describing` | One composer asking what this agent should do | Send one natural-language description |
| `drafting` | Name/role/behaviour/model/tool summary filling in live | Stop, revise in chat, or open Advanced |
| `ready_to_create` | **Create _Name_** with private/workspace placement and follow-up setup needs | Create once or edit |
| `creating` | One progress state; duplicate clicks disabled | Wait or safely reload |
| `created` | The real private home conversation with the original instruction present once | Agent responds and offers needed setup cards |
| `failed` / `expired` | Draft retained where safe plus a named remedy | Retry same idempotency key or start over |

### App and Gmail setup

| State | What the target user sees | Allowed next action |
| --- | --- | --- |
| `offered` | Up to three real app choices with publisher/trust, known capability count, target agent and scope | Select one, dismiss, or open Apps detail |
| `connecting` | Progress plus provider sign-in/reopen link | Finish sign-in, cancel, retry after expiry |
| `needs_secret` | “This app needs an API key” with secure dialog action | Enter once in dialog, cancel |
| `selecting_resources` | Gmail account verified; exact labels and initial history window are still unconfirmed | Select/confirm resources or disconnect; no import starts yet |
| `awaiting_scope_upgrade` | Existing read access remains usable; requested draft/send provider scope is not yet verified | Authorize the shown incremental scope, keep read-only, or cancel upgrade |
| `awaiting_grant` | Connected account plus exact discovered capabilities and target agent | Explicitly allow, manage in Apps, cancel the request (connection remains) |
| `ready` | Connected check, agent and scope, manage link | No mutation; continuation status is shown |
| `failed` | Sanitized actionable error; technical detail behind disclosure where safe | Retry from a fresh server decision or manage in Apps |
| `cancelled` | Nothing was granted; says whether a connection was already created | Start a new request |
| `expired` | Request expired; any completed connection remains manageable in Apps | Start again |
| `superseded` | A newer request for the same agent/thread/app owns the flow | Open the newer request |

Every render is reconciled against live state. A stale `ready` snapshot cannot
make the card claim that a now-disconnected app is usable.

The two Gmail-specific states are part of the persisted request enum, not
client-only phases. `awaiting_scope_upgrade` does not block read-only use that
is already verified.

### Mac executor setup

| State | What the owner sees | Allowed next action |
| --- | --- | --- |
| `offered` | Why the agent needs local access and the exact target agent | Open/use the Mac app or dismiss |
| `unsupported_distribution` | Browser, App Store build, or Windows-specific truthful explanation | Open supported Mac build; no remote mutation |
| `pairing` | Native folder picker and pairing confirmation | Choose/cancel locally |
| `awaiting_fingerprint_review` | Server fingerprint and machine label, no local path | Confirm or revoke |
| `awaiting_policy_review` | Exact read/COW/coding operations and target agent | Grant selected operations or keep read-only |
| `starting` | Packaged daemon launch and authenticated status | Wait, retry, or stop |
| `verifying` | Server is proving one bounded operation against the reviewed executor/grant | Wait or cancel; no agent continuation exists yet |
| `ready` | Machine online, approved revision, exact agent grant and successful server verification | Automatic continuation once |
| `verification_failed` | The request-bound bounded verification failed; no access claim or continuation | Reopen/review/restart from the classified remedy, then retry verification explicitly |
| `offline` / `revoked` / `failed` | Durable cause and local/server remedy | Restart, re-pair, re-review, or revoke |

## Authorization and security invariants

- UOA remains the sole identity and membership authority. Persist stable local
  references only; resolve live membership/roles for every click, grant and
  continuation. Do not copy email, display name, avatar, org or team hierarchy
  into the request.
- A request id is not a capability token. Every route loads it within the
  caller's organization, checks thread entitlement, and separately requires
  `requestedByUserId` for action controls.
- Candidate ids, selected app, agent id, install scope, connection id and grant
  keys are re-resolved server-side. Client/message/model values never widen
  authority.
- Authorization URLs are returned only as an immediate action response, never
  stored in message metadata, request JSON, audit metadata, logs, analytics or
  push payloads. OAuth state remains random, one-shot and short-lived.
- All MCP, authorization, token and redirect endpoints continue through the
  shared SSRF/IP-pinning and redirect policy. The chat layer never calls a URL
  itself.
- Secrets never enter chat. The legacy `connector_set_secret` tool is removed;
  every agent, including the PA, can only render the secure dialog action whose
  authenticated route writes through the encrypted secret seam.
- The app presenter continues to hide endpoint, auth config, transport config,
  raw upstream icon URL and credential refs.
- Community listings name their publisher and trust state at consent. The card
  cannot present an app author's claimed brand as publisher verification.
- Rate limits match the existing Apps/OAuth buckets. Repeated cards also have a
  per-user/agent/thread cooldown enforced structurally, not by inspecting text.
- Audit entries cover offered, selected, connect-started, secret-submitted
  (never the value), grant-changed, finalized, cancelled, expired, retry and
  reauthorization transitions. Metadata is ids/status/counts only.
- The agent card is not a disclosure bypass. Viewer-specific request DTOs,
  message basis inheritance, and connector-result provenance all apply.
- Quick create reuses `CreateAgentBodySchema`, Ledger model validation,
  `validateAgentCreateInput`, protected-tool checks and atomic private-home
  creation. A model-produced draft cannot set `agentKind`, `systemManaged`,
  delegation, stewardship, protected tool provenance or a foreign owner.
- A profile-change request is constrained by field allowlist and structure; it
  never calls the broad update route on the model’s behalf. The live owner and
  exact private home are re-read on every apply.
- Gmail account identity is per user and never becomes a Nessie/UOA identity
  authority. External address/profile values are provider account display data
  only, omitted from shared cards and disclosure-stamped when read by an agent.
- Gmail send extends approval suspension with a server-loaded snapshot of
  canonical recipients, subject, account, attachment refs and body digest.
  Approval/send recompute those facts; editing any invalidates the approval.
  Draft permission is not send permission.
- Executor readiness is the conjunction of signed supported desktop,
  authenticated daemon session, current reviewed descriptor, scope assignment
  and exact agent operation grants. A green local process alone is not ready.
- Local paths, hostnames, CLI inventories and command output do not enter setup
  cards, audit metadata or model context. Agent-visible machine labels come
  from the existing safe executor presenter.

## Agent communication contract

The tool descriptions and stable prompt block tell a configured agent:

- During creation, choose a useful name/role/brief from the person’s request and
  configure the draft; do not ask for fields that can be inferred. Name every
  consequential capability that will still need the person’s approval.
- A runtime agent may propose its own name or role change, but may not claim the
  change landed until the server card confirms it.
- Search the Apps catalogue when a required capability is unavailable; never
  invent an app or authorization link.
- Offer at most three useful choices and explain the decision each enables.
- Do not say an app is installed, connected, granted, watching, or working
  until the corresponding server state/tool call proves it.
- Once a card is posted, give a short explanation and wait. Do not ask the user
  to paste a token, an instance id, or “tell me when you're done”.
- On the server-authored ready kickoff, continue the original task immediately.
- If no trigger exists, say that the check is one-off and point to/create a
  trigger only through the existing authorized trigger flow. Never promise a
  background watch merely from prose.
- For Gmail, distinguish connected, imported/readable, draft-capable and
  send-approved. Never say “I can manage your inbox” from a read-only token.
- For local execution, distinguish “the desktop companion exists,” “this Mac is
  paired/online,” “I have these exact operations,” and “the operation actually
  succeeded.” Never infer host access from being inside the desktop webview.
- Follow the person's language and phrasing through model judgement; there is
  no language or intent keyword list.
