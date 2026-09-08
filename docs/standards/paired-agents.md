# Paired agents — lending an account to an outside program

Authoritative standard, written in the shape [`AGENTS.md`](../../AGENTS.md)
uses for the rest: `AGENTS.md` carries the one-line invariant and points here;
**this file is the rule**.

Nessie is an MCP **server** as well as a client. `/api/mcp/*` manages
connectors Nessie calls *out* to; this is the other direction — an outside
agent (a Claude Code or Codex CLI on somebody's machine) calling *in* on
`POST /mcp`, holding a credential a person deliberately lent it.

## The invariants

- **The credential is never an identity.** It names a human and every tool call
  runs as that human, against the same service functions the HTTP routes call.
  An agent therefore cannot reach anything its granting human could not reach by
  clicking. Scopes only ever narrow that reach; they never widen it. This is the
  same rule [`personal-assistant-tools.md`](personal-assistant-tools.md) states
  for the assistant's own tools, and a new tool that re-derives an access
  decision instead of calling the shared predicate is the way it gets broken.
- **Liveness is re-read on every call, never trusted from the token.**
  Revocation, expiry, `User.tokenVersion`, organisation membership and the live
  role are all checked per request in `verifyAgentAccessCredential`, so
  "sign me out everywhere", a demotion and a deactivation all land on the next
  call rather than at expiry.
- **Publishing is a request, never a grant.** "Agents draft; only a human may
  publish" is enforced for in-house agents by refusing an `agent` actor
  outright (`api/src/routes/knowledge-base.ts`). A credential resolves as a
  `user`, so that refusal cannot catch it. `nessie_doc_publish` therefore opens
  the same `knowledge.page.publish` approval `kb_publish_request` opens, pinned
  by `requiredApproverUserId` to the person whose account it borrows.

  **There is deliberately no `documents_publish` scope, and adding one back is
  the defect this standard exists to prevent.** It was tried: a checkbox at
  pairing time saying "this agent may publish". It decided, once and for ninety
  days, a question this product asks per document everywhere else — and it
  decided it *before the document existed*, so the person ticking it could not
  know what they were agreeing to publish. Every standing grant in this product
  (`SendAuthorizationGrant`, `ScopeDisclosureGrant`,
  `BrowserPersonalAccessGrant`) is per-agent-per-resource with a granter-chosen
  duration and a visible running count. A pairing-time tick is none of those.
- **An approval has exactly one asker.** `ApprovalRequest.agentId` and
  `agentAccessCredentialId` are a one-of, enforced by a CHECK. A credential
  request sets `requesterId` to the **credential** id, never the human it acts
  as: `resolveApprovalRequest` refuses a requester who answers their own
  request, so naming the human would make the one person entitled to decide the
  one person who cannot. `api/test/mcp-publish-approval.test.ts` pins that.
- **Attribution rides the actor context, not each tool.** The verifier puts
  `agentCredentialId` on `actionContext`; `emitAuditEvent` stamps it into
  metadata for every event. A marker each tool has to remember is a marker the
  next tool forgets — which is exactly how document writes ended up carrying
  `via` while board writes carried nothing.
- **Pairing is an organisation's decision as well as a person's.** The
  `agents.pairing` key rides the one settings cascade
  ([`scoped-settings.md`](scoped-settings.md)) — organisation → team → person,
  absent means allowed — and is checked at approval time, because nobody is
  signed in when an agent *starts* a device request. An owner sees every
  credential in the organisation at `/settings/organization/paired-agents` and
  can revoke any of them. The personal list stays self-only: a credential list
  is a list of live footholds, not general reading.

## The flow, and why it is this one

RFC 8628 device authorization grant. A CLI agent controls no browser and can
host no callback URL, so the authorization-code redirect is unavailable to it.

1. `POST /mcp/auth/device` → `{ device_code, user_code, verification_uri,
   verification_uri_complete, interval, expires_in }`.
2. The human opens the URI while signed in, sees **which agent, as whom, until
   when, and what it will be able to do**, and allows or refuses.
3. `POST /mcp/auth/token`, polled, honouring `authorization_pending` /
   `slow_down` / `expired_token` / `access_denied` → the `nag1_` credential.

Discovery is RFC 9728: `/.well-known/oauth-protected-resource` says plainly that
no authorization server runs here and names the device endpoints instead.

Full OAuth 2.1 authorization-code + PKCE is a deliberate later step. It buys
browser-based clients a nicer first run and does nothing for the headless case,
which is the one that blocks agents today.

## The surface

- `/settings/paired-agents` — a person's own. Leads with what a paired agent
  *is* and names the products (Claude Code, Codex); the code entry is the
  fallback path, because most arrivals come through
  `verification_uri_complete` with the code already in the query.
  `/settings/agent-access` redirects here **preserving the query string** — an
  agent that printed the old URI before the rename is still holding it, and
  dropping `?code=` would kill a pairing three seconds from done.
- `/settings/organization/paired-agents` — owner and organisation admin. Every
  credential in the organisation, whose account each borrows, and the pairing
  switch.

**Do not call either of these "agent access".** Four other surfaces in the admin
use "agent access" / "agents with access" to mean *which of Nessie's own agents
may reach this resource* — the knowledge space dialog, the mailbox panel, the
workflow-tool panel, the app detail view. This is the inverse, and the collision
is not theoretical: it is what made the page unreadable to the person who owns
the product. The vocabulary here is **pair**, **paired agent**, and
**Allow / Don't allow** — never "approve", which belongs to `ApprovalRequest`.
