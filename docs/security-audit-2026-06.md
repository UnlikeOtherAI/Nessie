# Security & DB audit (2026-06), re-verified against `main` (2026-08-06)

A multi-round security and database audit ran in June 2026 on the branch
`security/audit-2026-06-13`. That branch was never merged and fell ~336 commits
behind `main`, which was heavily refactored in the meantime. Rather than merge a
stale branch, every finding was **re-verified against the current code** and the
ones that still applied were re-implemented here.

The original branch was deleted on 2026-08-06 once this work landed. Its tip was
`e1518015` ("fix(security): KB-comment tools respect owner space access for the
PA"), carrying 22 commits from `d9a4dc20` onward; the findings themselves are
recorded below, so the branch itself is no longer needed.

**How to read this.** Each finding below records what the June audit found and
what the 2026-08-06 re-verification concluded. "Obsolete" means current `main`
already closes it (often by a different, better route); "Re-applied" means the
gap was still open and is now fixed on `main` with tests.

---

## Obsolete — already closed by current `main`

| Finding | Why it no longer applies |
|---|---|
| `PUT /api/agents/:agentId` had no org/access check | `isAgentAccessibleToActor` gates it, and every sibling agent route |
| Agent binding routes org-checked the channel but not the agent | Both are gated now |
| `addPolicyBinding` / `removePolicyBinding` ignored the rule's org | Both scope via the parent rule and 404 cross-org ids |
| KB search applied its access filter *after* `LIMIT`, leaking ids through the cursor | `readableSpaceIdsSqlForViewer` pushes the predicate into the SQL |
| Unbound `@mention` could execute an agent not bound to the channel | `channelAgents` derives from `agentBindings`, so only bound agents are candidates |
| Trigger `config.createdByUserId` was free-form client input | `stripServerOwnedTriggerConfig` makes launch identity server-owned |
| Personal assistant had org-wide channel reach | `buildVisibleChannelWhere` and the memory scope resolver are membership-scoped; the `orgWide` flag is gone |
| `schedule_task` had a duplicate org-wide channel resolver | `visibleChannelWhere` in `schedule-tools.ts` is membership-scoped |
| KB-comment tools hardcoded a bypass viewer | `buildSpaceViewerPrincipal` resolves a real user/agent principal |
| Attachment download served SVG inline and could MIME-sniff | SVG is excluded from inline disposition and `nosniff` is sent |
| PA `attachment_read` authorized on org match alone | It resolves the linked message through visible channels |
| KB native search scanned `COALESCE(metadata::text,'')` per row | The predicate is gone |
| Human message search used an un-indexable ILIKE | It uses `to_tsvector` against `messages_content_fts_idx` |

## Re-applied — still open, now fixed

### SSRF
`assertSafeUrl` validated a URL and then handed the hostname to a fresh `fetch`,
which re-resolves at connect time — a DNS-rebinding TOCTOU. `@nessie/runtime`
`url-safety.ts` now also exposes `assertSafeUrlPinned`, `createPinnedFetchAgent`,
`pinnedFetch` and `safeFetch`: resolve once, pin the socket to the validated
addresses via an undici dispatcher that re-checks each address as it dials, and
re-validate every redirect hop. Pinned agents are cached by address set so this
costs no extra TLS handshakes.

Wired into: MCP OAuth authorization-code exchange (which carries the client
secret, and refuses redirects outright), MCP metadata discovery, dynamic client
registration and token refresh, the MCP SDK streamable-HTTP and SSE transports
(via the SDK `fetch` option — the round-2 deferral), FCM `token_uri` on both the
validation and runtime send paths, `web_fetch` and `http_fetch`.

Inference provider `baseUrl` is additionally SSRF-validated **at write time**
(`INFERENCE_PROVIDER_BASE_URL_UNSAFE`), because a stored internal URL is a
persisted primitive that every later call re-aims at.

### Cross-tenant
- The MCP catalog was reachable across tenants: `getAccessibleCatalogEntry`,
  `canManageEntry` and every `listCatalogEntries` view (including `all` and
  `queue`) are now floored to the actor's organisation plus instance-global
  rows. An org owner is not a superuser, and private catalog rows hold plaintext
  OAuth client secrets.
- The API stripped `authConfig.clientSecret` on the way out but left
  `defaultTransportConfig` intact, so an API key or `Authorization` header
  parked there went to every viewer of the published store. Both are redacted,
  keeping URLs and ids readable.

### Access control
- **SSO email takeover.** Userinfo carrying `email_verified: false` is refused;
  accounts are matched by email. Providers that omit the claim are trusted as
  before.
- **Approvals** were org-scoped only, leaking private-channel `reason`/`context`
  and harvestable task ids. List, get, pending-count and resolve share one gate:
  owners see their org, everyone else sees what they requested plus channels
  they can reach.
- **Agent edits** (`PUT`, `PATCH /avatar`) are owner-only. Visibility comes from
  a channel binding, so any member of a public channel an agent was bound to
  could rewrite its `systemPrompt`, `toolPolicy` or model.
- **Project isolation.** Tasks, boards, iterations, insights and the project list
  are gated by project membership (`isProjectAccessibleToActor`,
  `listAccessibleProjectIds`). All five task **mutations** go through
  `requireTaskAccess` — the round-8 gap where reads were gated but mutations
  passed org scope only, letting a non-member tamper with another project's task
  and read it back out of the response.
- **Memory-audience poisoning.** Capture verifies the actor belongs to the
  client-supplied channel/team/project audience before writing.
- **Session revocation.** Logout revoked the refresh family but left the access
  token valid for the rest of its TTL. `User.tokenVersion` is minted as the `tv`
  claim and compared on every request.
- **Unlinked attachments** are readable by their uploader, or once genuinely
  published as an avatar, org logo or feedback attachment — not by any org
  member holding an id.
- **PA `attachment_list`** no longer falls back to whole-org visibility for an
  autonomous run; it is bounded by the run's own channel.
- **PA triggers** are re-checked against the owner's channel membership at fire
  time. The PA is exempt from the *binding* gate, not from its owner's reach: a
  schedule created while the owner was a member kept firing into a private
  channel after they were removed.
- Project/team member-add confirms the target user belongs to the actor's org.
- Attachment downloads send `default-src 'none'; sandbox` alongside `nosniff`.

### Database
- **Tenant foreign keys** (migration `20260806150000`). 39 child tables carried
  `organization_id` as a bare scalar and the three knowledge tables carried a
  required `project_id`, all with no FK — nothing stopped a row being tagged
  with another tenant's id, nothing cleaned up on delete, and a dangling id was
  indistinguishable from a real one.
- **Restored FTS indexes** (migration `20260806160000`).
  `idx_thoughts_search_vector` and `idx_thoughts_metadata` were dropped by
  `20260516202000_reconcile_drift` and never recreated, while
  `match_thoughts_lexical`/`match_thoughts_hybrid` still filter and rank on
  `search_vector` — every memory recall was sequentially scanning `thoughts`.
- **Authorization index** (migration `20260806140000`) covering the `checkPolicy`
  predicate, which runs on every tool invocation.
- **N+1 and scan fixes**: `listIterations`, the board reindex,
  `recordInferenceUsage` pricing lookups, `/auth/me` membership loading, the
  unread-count query, and agent conversation search (now FTS-backed, sharing
  `buildPrefixTsQuery` with the human search path).

## Deliberately not re-applied

| Finding | Decision |
|---|---|
| IP-pin the inference connectors' own outbound calls (round 10) | The deployment-wide model base URL is operator config, and the supported mock-LLM smoke/load harness points it at `127.0.0.1` (`worker/test-harness/smoke.ts`). A hard block breaks documented local testing. The tenant-supplied half of the surface is covered by the new write-time `baseUrl` check. |
| `sandbox=""` on the KB PDF preview iframe | Verified in Chrome: **any** `sandbox` attribute stops Chrome's PDF viewer from loading a `blob:` URL, so this silently breaks the preview. The blob's MIME is already pinned to `application/pdf`, which is what closes the script-execution path. |
| `web_fetch` / `http_fetch` seeded disabled (opt-in egress) | There is no admin surface to re-enable a builtin tool, so seeding it off breaks the feature with no recovery path short of a hand-rolled API call. The exfiltration concern is mitigated by the SSRF guard + IP pinning above and by per-agent `toolPolicy` grants. Revisit if a tool enable/disable UI lands. |
| `PolicyRule.scopeId` → `@db.Uuid` | Rejected in June and still correct: `scopeId` is polymorphic and holds tool *names* (e.g. `web_fetch`) for tool-scoped rules. |
| Password-login mode gate | Rejected in June and still correct: the self-hosted bootstrap owner logs in by password, and password login already requires an existing `passwordHash`, so SSO users have none. |
| FK on `UoaSessionCredential.organization_id` | That column holds UOA's *own* organization identifier — an opaque provider string, not a local `Organization.id`, which is why it is `text`. A foreign key there would be semantically wrong. |

## Verification

Lint, typecheck and the full API / worker / runtime / package test suites pass.
The complete migration chain was applied to a clean pgvector database: all
migrations converge, the 42 new constraints and both restored GIN indexes are
present, and `prisma migrate diff` reports no drift for any of them. The
unread-count rewrite and the bulk board reindex were checked against real
Postgres for identical results.
