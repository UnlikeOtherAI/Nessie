# Security boundary hardening — system design v2 (2026-08-13)

Status: **v2 — amended after two adversarial external reviews** (Kimix, Codex
Sol; both reviews verified claim-by-claim against the tree before adoption —
see Appendix). v1's chokepoints were, as both reviewers proved, mostly new
*functions* rather than boundaries; v2 makes each boundary the only spelling.
Implementation: Phase 0 items are cleared to build now; items marked
**[access-model]** are deferred pending the owner's access-semantics decision.

Input findings: S1–S14 (audit addendum), Kimix design review (K-*), Sol design
review (SB-*/CB-*/M-*). Correction carried back into the audit doc: **S11 is
exploitable today** — `worker/src/run/execute/agent-loop.ts` dispatches
`delegate` (L277), MCP (L300), and executor tools (L303) *before* the
registry/grant gate (L306) and policy evaluator (L337), and delegated
sub-agents dispatch builtins/MCP with no policy, approval, registry, or
telemetry at all (`delegate.ts:83-127`) — confirming the repo's own G11
analysis ("live authorization bypass",
`docs/plans/2026-08-11-inter-agent-communication/current-state.md:118`).

## Design principles (v2)

1. **Authorization and dispatch are one API.** A tool call, a session
   issuance, a secret resolution, a membership write, an outbound dial — each
   is performable only through the function that also authorizes it. Raw
   dispatchers, raw signers, raw decryptors, and raw table writes become
   private to their owning module.
2. **Branded types make bypass a compile error.** The privileged primitive
   accepts an opaque type (`ResolvedSessionContext`, `SecureTransport`,
   `PublicOrigin`, `AuthorizedToolCall`) constructible only inside the
   boundary module. Lint is defense in depth, never the boundary itself
   (Sol CB-01/CB-05/CB-06).
3. **Sensitivity is typed, never inferred.** No header-name sniffing:
   requests carry `credentialsPresent` structurally from the code that
   attached the credential; OAuth exchange/refresh and secret-bearing calls
   are `redirectPolicy: 'none'` **by construction** (Sol SB-05, Kimix 1.2).
4. **Install scope is a ceiling.** Explicit policy may narrow exposure,
   never broaden it past the connector's install scope; user-owned secrets
   resolve only with the expected owner (Sol SB-02).
5. **Durable work re-resolves live authority.** Enqueue-time actor snapshots
   are claims; role/membership is re-read at claim time and before external
   side effects (Sol SB-03; generalizes `resolveActingMember`).
6. **Long-lived connections carry session identity.** `sid` + user + org +
   channel on every SSE/WS connection; revocation closes by `sid`; fan-out
   checks live state, with push-based (pg NOTIFY) cache invalidation, never
   TTL-only (Sol SB-04, Kimix 3.4).
7. **Migrations are expand/contract.** The deploy order is
   migrate-then-restart with old processes live (`redeploy.sh:54-58`):
   nullable columns + dual-write + bounded backfill + `NOT VALID` →
   `VALIDATE` + concurrent indexes; data preflights are operator-run release
   gates, never steps inside unattended `migrate deploy` (Sol M-03/M-09,
   Kimix 3.1).

---

## Workstream 0 — One pre-dispatch tool-authorization boundary (S11→SB-01) — **Phase 0, critical**

`authorizeAndDispatchToolCall` becomes the only way the loop (and the
delegate sub-loop) executes any tool: main builtin, main MCP, main executor,
delegated builtin, delegated MCP. It rebuilds the authorization context for
the **actual** tool name (Sol's nested-context trap: delegated builtins
currently inherit a context built for `delegate`), applies registry/scope/
grant/policy/approval in fixed order, and emits identical audit + ToolCall
records on allow and deny. Raw dispatch functions (`mcpView.dispatch`,
`executorToolset.dispatch`, `executeGuardedBuiltin`'s direct call) become
module-private. Regression tests: one deny and one approval case per path
(×5). Note this only enforces rules owners already write today — it needs no
access-model decision.

## Workstream 1 — Session & tenancy integrity (S1, S9; SB-06, CB-01, M-07)

- **Resolver requires the user's whole chain**: active `OrganizationMember`
  **and the same user's** `ProjectMember` and `TeamMember` for any selected
  project/team — object hierarchy alone is a regression against today's
  switch-context route (Sol SB-06). UOA sessions keep their exact fail-closed
  binding; the generic path can never move a UOA family (Kimix 3.2).
- **Branded issuance**: the resolver returns an opaque
  `ResolvedSessionContext`; user-session issuance accepts only that type;
  `issueSessionToken` becomes private to the auth module
  (ESLint `no-restricted-imports` as backstop). System actors get a distinct
  machine-actor type — never a user token with a missing membership row.
- **Central auth stops failing open**: a user JWT whose claimed org has no
  live active membership is rejected (today it keeps the token's roles,
  `server-context.ts:285-310`); the same cached read revalidates the
  project/team selection, closing the access-token tail after child-
  membership removal (Sol SB-06). Cache invalidation is push-based via pg
  NOTIFY on membership/session mutations — the mutations all flow through
  Workstream 4's writers, which own the notify.
- **Session state gets one row.** Correction (Sol M-07/#9): `sid` is already
  a required claim; the refresh-family table is the wrong revocation
  authority (every rotation revokes predecessor rows sharing the sid, and
  there is no sid index). Add an `AuthSession` row (sid pk, userId, selected
  org/project/team, revokedAt) — the selection store for refresh replay
  (replacing v1's two RefreshToken columns), the target of
  `DELETE /sessions/:id` and password change, and the source for the cached
  per-request check. Non-UOA switch-context mints a new sid without family
  rotation today; the new algorithm is specified around the session row, with
  concurrent refresh/switch behaviour under the existing family locks.
- **Membership writers** call `assertTenantHierarchy` (which subsumes the
  existing `validateTenantHierarchy` — v1's "only correct copy" claim was
  wrong, Kimix §4.6) *inside* their transactions, and re-check entitlement
  inside the write predicate, not in a preceding read (TOCTOU, Sol CB-07).
- **Database backstop, corrected** (Sol M-01/M-02): v1's FKs proved object
  ancestry only. The invariant is *same-user membership ancestry*:
  `ProjectMember(organization_id, user_id) → OrganizationMember(organization_id, user_id)`
  and `TeamMember(project_id, user_id) → TeamMember→ProjectMember(project_id, user_id)`,
  plus `channels`' denormalized triple constrained via composite FKs (Kimix
  2.5). `projects` already has `@@unique([id, organizationId])` — reuse it.
  Existing team-only memberships are inventoried by the operator preflight;
  **whether they become parent memberships or a distinct entitlement model is
  [access-model]** — the constraint ships after that disposition.
- Rollout per principle 7; old-replica NULL-selection interleaving during the
  deploy window is documented and accepted (Kimix 3.2).

## Workstream 2 — Secret custody (S2, S13; SB-02, CB-04, CB-08, M-04/05/06/11)

- **Phase 0 slice**: the public API immediately rejects **new** caller-chosen
  env refs (grandfathered rows keep resolving); workers gain a dual resolver
  (env-name OR store-ref) **first**, before the API ever writes a `secret_*`
  ref — the v1 ordering would have turned drained jobs into "Missing API
  key" outages (Sol M-06). `authSecretRef` is removed from the **shared**
  schema too (`packages/schemas/src/inference-routing.ts:227`), not just the
  api contract (CB-08).
- **The store is a capability, not a table.** Crypto primitives leave the
  runtime barrel; the secret package owns table access; discriminated
  store/resolve inputs make scope cardinality type-enforced (inference ⇒
  org; user-scoped MCP ⇒ org+**owner** — the owner expectation is what
  closes SB-02's resolution half; platform push ⇒ explicitly global) with
  matching DB CHECK constraints. Direct-decrypt callers (the worker push
  path, `push-delivery-core.ts:85-99`) migrate onto the capability.
- **Migration is an inventory, not a copy** (Sol M-04/M-05): the existing
  rows span two encodings (JSON `StoredBundle` vs raw plaintext) and five
  ownership paths (instance credential, per-principal override, dynamic
  OAuth client, global push, dashboard source) — plus the separate comms
  credential tables v1 forgot (M-11). Versioned purpose-specific envelopes;
  dual-write + old-fallback reads across a release; refs shared across
  scopes are cloned/rotated; orphans quarantined; per-purpose
  decrypt-and-use verification; legacy storage dropped a release later.

## Workstream 3 — Egress (S3, S4, S8; SB-05, CB-05, CB-06; audit finding 2)

- **Typed sensitivity**: `applyAuth`-style code paths (MCP auth-apply, OAuth
  clients, identity-header attachment) mark the request `credentialsPresent`
  structurally; MCP API-key auth uses caller-chosen header names, so
  header-list sniffing can never classify it (Sol SB-05). Credentialed or
  body-bearing requests refuse cross-origin redirects outright (307/308 body
  replay is refused, not "rewritten"); OAuth exchange/refresh is
  `redirectPolicy: 'none'` by construction. Header normalization at
  `safeFetch` entry covers `Headers` / arrays / records / `Request` input
  (Kimix 1.2) as defense in depth under the typed flag.
- **Transport required at the lowest seam** (Sol CB-05 / correction 6):
  `createInferenceService` — which the worker's inference stage calls
  directly, bypassing `createModelClient` — takes a required
  `SecureTransport` (branded, built only inside runtime); connectors lose
  global-fetch defaults; same for `sendWebPush`/FCM, whose *delivery-layer*
  seams (`web-push-delivery.ts:112` `sender ?? sendWebPush`,
  `fcm.ts` `fetchImpl = defaultFetch`) are retyped so the pinned transport is
  the only constructible input (Kimix 1.1). OIDC (`external-auth.ts`) and
  UOA session fetches move onto it with issuer-origin pinning covering
  `token_endpoint`, `userinfo_endpoint`, **`jwks_uri` and
  `authorization_endpoint`** (Kimix §4.2). Config-load URL validation gets an
  awaited startup phase (Sol correction 12) and still pins at dial.
- **The lint is an AST/import boundary, not a call-spelling rule** (CB-06):
  every reference to global/`globalThis` fetch, `node:http(s)`, and direct
  undici clients across **all** production trees (including `executor/`,
  `cli/`, `packages/comms-*`, `workspace-admin`'s ledger catalog, the UOA
  billing/avatar clients) resolves to the branded transport or an
  allowlisted entry; the allowlist is production-code-only with admission
  criteria stated in the rule file, snapshot-tested.

## Workstream 4 — Entitlement chokepoints (S5–S7, S10; SB-04, SB-07, CB-07, M-08)

- **Channel membership**: one actor-aware service owns **all** writers —
  add, remove, self-join (`joinPublicChannel`), the DM→group fork
  (`createGroupFromDm`), and the PA-DM refusal — with the active-actor check
  *inside* (both existing `canManageChannel` copies lack `deactivatedAt`;
  Kimix §4.3 / Sol correction 5), audit + the SSE close-publish + the pg
  NOTIFY for auth caches in the same transaction. `prisma.channelMember`
  writes outside the module fail lint; DB trigger as backstop. The *policy
  action* is a real vocabulary member (v1's `manage` does not exist — Sol
  M-08) chosen with a seeded-rule migration so existing orgs don't fail
  closed. **Which roles may manage members is [access-model]** — until
  decided, the service preserves current API behaviour behind the single
  chokepoint (structure now, semantics when decided).
- **Runs**: `loadRunForActor` replaces `loadRunForOrg`, which is **deleted**
  in the same change (Kimix 1.5); mutation services revalidate entitlement
  inside the write predicate (TOCTOU, CB-07). The run-ID consumer inventory
  includes executor availability/bind (`/api/runs/:runId/executor-bind`
  currently checks org/project but not channel access — Sol SB-07).
  **The narrowing itself (member run visibility, PA-run rules, executor-bind
  entitlement) is [access-model]**; the loader consolidation and TOCTOU fix
  are not, and land first.
- **Realtime**: every long-lived connection (thread SSE, user SSE, WS)
  stores `sid`/user/org (+ channel for thread streams, resolved once at
  connect); fan-out and backlog hydration check session-not-revoked and
  **active org membership** — `getVisibleChannel` alone trusts the org claim
  and retained membership rows, so it cannot be the whole check (Sol SB-04);
  targeted revoke and deactivation close connections by `sid`/user. The
  4b/4b′ writers own the close-publish, so no revocation path can forget it.
- **Durable-work authority** (SB-03): at claim, the worker re-resolves the
  live acting member and replaces snapshot roles; deactivation cancels
  pending user-originated runs where safe; system jobs use the typed machine
  origin from Workstream 1.

## Workstream 5 — One policy engine, one origin (S11, S12; CB-02/03, SB-08, CB-09)

- The evaluator merge follows Workstream 0 (the boundary is what makes any
  evaluator load-bearing). Reconciliation is **semantic, not just default**:
  approval-proof handling moves *into* the shared evaluator; malformed
  `timeWindow` fails closed (today the shared copy `.includes` over an
  uncast shape); a differential corpus runs both implementations to
  equivalence before the worker copy is deleted (Sol CB-03). Whether the
  policy vocabulary's unenforced surfaces (tasks, sessions, secrets…) become
  load-bearing is **[access-model]** — until then the vocabulary/coverage
  matrix is documented so a deny rule is never silently advisory (CB-02).
- `resolvePublicOrigin` returns a branded `PublicOrigin` required by every
  callback/registration builder; **hosted/production mode requires the
  configured public URL** — request-derived origins (including the direct
  `Host` header, which proxy-trust does not protect) are local-dev only
  (Sol SB-08). Lint bans `x-forwarded-*` / `headers.host` reads outside the
  resolver and the trust-proxy plumbing (Kimix 2.4, CB-09).

## Workstream 6 — Contract authority (S14)

`api/src/contracts/inference-core.ts` derives from `packages/schemas` with a
conformance test asserting the api surface is **at least as strict** (not
blind re-export — the two layers serve different audiences; Kimix §4.5).
The shared-schema `authSecretRef` removal lands here with Workstream 2's
Phase 0 slice.

---

## Sequencing (rebuilt: exploit-liveness first — Kimix §6, Sol M-06)

**Phase 0 (days, ship independently):**
1. W0 dispatch-authorization boundary (minimal form: gate-before-dispatch on
   all five paths + context rebuild; refactor to full module later).
2. SB-02 ceiling: `isExposed` scope check becomes unconditional for
   non-explicit-grant rows; user-scope credential resolution requires the
   owner expectation.
3. Webpush/FCM pinned at the delivery seam (retyped sender); OIDC + UOA
   fetches pinned, `redirectPolicy: 'none'`, discovery endpoints
   origin-checked.
4. New env-ref writes rejected (dual resolver in workers first).
5. Hosted mode requires configured public origin; `x-forwarded`/Host lint.

**Phase 1:** W4 structure (single channel-membership service preserving
current semantics; `loadRunForActor` + delete `loadRunForOrg`; TOCTOU
predicates); W5 evaluator reconciliation + differential corpus; realtime
session identity + close-by-sid.
**Phase 2:** W3 in full (typed sensitivity, lowest-seam transport, AST lint
boundary); W6.
**Phase 3:** W1 (AuthSession row, branded issuance, central-auth fail-closed,
resolver, notify-invalidated caches; membership FKs *after* the [access-model]
disposition of team-only memberships).
**Phase 4:** W2 store + inventory-driven migration (dual-write across
releases; comms included or explicitly excluded in writing).

Each phase ships its boundary tests, its lint additions, and its migration
preflights together. A data-bearing adversarial upgrade fixture (multi-org
incoherent memberships, rotated refresh family, every secret encoding class,
active inference bindings — Sol M-10) is a Phase-1 deliverable because every
later phase's migrations need it.

## Deferred pending the access-model decision **[access-model]**

Channel-member management roles (S5 semantics); member-facing run
visibility/cancel scope + PA-run rules (S6) and executor-bind entitlement
(SB-07 semantics); `/api/teams` unfiltered same-org listing (SB-06's ambient
enabler); expansion of enforced policy coverage (CB-02); disposition of
team-only memberships (M-01). The structural work above deliberately
*contains* each of these behind one chokepoint so the future decision is a
one-place change.

## Enforcement matrix (v2 — every boundary mechanically defended)

| Boundary | Mechanism |
| --- | --- |
| Tool dispatch | Single boundary fn; raw dispatchers private; 5×2 regression tests |
| Session issuance | Branded `ResolvedSessionContext`; signer private; restricted-import lint |
| Central auth | Fail-closed live-membership check + notify-invalidated cache; revoked-`sid` test |
| Secret resolve | Capability package owns table+crypto; discriminated inputs; DB CHECKs; snapshot-tested allowlists |
| Egress | Branded `SecureTransport` required at lowest seams; AST fetch boundary, all trees; redirect tests incl. arbitrary header names + body replay |
| Membership writes | One service; lint + DB trigger on direct writes; deactivated-actor + non-ASCII-tenant tests |
| Run access | Old loader deleted; entitlement inside write predicate |
| Public origin | Branded `PublicOrigin`; hosted requires config; header-read lint |
| Contracts | Strength-conformance test |

## Appendix — review provenance

v1 was reviewed adversarially by Kimix and Codex Sol. Every claim folded into
v2 was re-verified against the tree (spot-checks this round: dispatch order
in `agent-loop.ts:277-337`, `isExposed` policy-true-before-scope, the
credential fallback, `sid` non-optionality, `createInferenceService` direct
call, the existing `projects` composite unique, `manage` absent from the
policy vocabulary, shared-schema `authSecretRef`, both `canManageChannel`
copies lacking `deactivatedAt`, G11's prior documentation of the delegate
bypass — all confirmed). Sol's review found the most severe gaps (SB-01/02,
the FK conceptual error, the migration-order outages); Kimix independently
found the enforcement-gap pattern (§5 "one of eight boundaries defended"),
the webpush seam placement, header-shape normalization, `jwks_uri`, and the
Phase-0 reordering. The reviews disagree nowhere material; where v1
disagreed with them, v1 was wrong (documented corrections: S11 exploitability,
composite-unique existence, `sid` claims, chokepoint placement, FK semantics,
"only correct copy", `manage` action).
