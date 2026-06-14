# Nessie Enterprise & Big-Corp Readiness Roadmap

> **Status:** assessment / planning input — not yet validated or scheduled.
> **Date:** 2026-06-14
> **Method:** ten independent Opus assessors, each adopting a distinct enterprise
> stakeholder persona and grounding its findings in the actual codebase
> (`file:line` citations), reconciled by a synthesis pass into the single
> roadmap below. Full per-persona assessments are in the appendix.
> **Caveat — verify before acting:** these are agent findings. The sharp,
> specific claims (e.g. "policy engine governs 4/47 routes", the `openStream`
> isolation near-miss, the orphaned approval gate, the advisory spend cap, the
> dead `saml`/SCIM placeholders) must be spot-checked against the real files
> before any of them is turned into committed work. Treat severity ratings as
> proposals to re-grade, not facts.

---

## Executive summary

Nessie has a credible *architectural* foundation — a real deny-overrides policy engine, a Postgres-backed queue with correct concurrency primitives, a shared SSRF guard, AES-256-GCM secret encryption, refresh-token rotation with reuse detection, and a token-cost ledger with rich attribution — but almost none of it is wired up to the standard a Fortune-500 security, IAM, GRC, and procurement review actually requires. The recurring failure pattern is **"capability exists in the schema or in one corner of the code, but is not enforced, not covered, or not operationalized"**: the policy engine governs 4 of 47 routes, the approval gate denies but never pauses/resumes, the spend cap is advisory, the audit log is mutable and ~20% covered, isolation rests on hand-written `WHERE` clauses, and production is a hand-built single-VM snowflake with no backups, no DR, no secrets vault, and no encryption at rest. **Overall maturity: early.** It is a promising platform for small trusted teams, but it is not deployable into a regulated enterprise today without a substantial, sequenced remediation program.

## Table stakes missing

Capabilities a Fortune-500 security/procurement review will simply require that are **absent today**:

**Identity & access**
- SAML 2.0 SSO (the `saml` enum value is a dead placeholder; OIDC-only) — *IAM architect*
- SCIM 2.0 provisioning/**deprovisioning** (JIT-only create, manual-only deactivate; leavers keep live accounts + 30-day refresh tokens) — *IAM architect, procurement*
- IdP group → role mapping (`mappingRules` is declared-but-dead config; all SSO users hardcoded to `member`) — *IAM architect, RBAC*
- MFA / step-up enforcement in-product (the `VerificationFactorType` schema is dead) — *IAM architect*
- Service-account / API keys (scoped, revocable, rotatable) for automation — *IAM architect*
- Custom/configurable roles and a read-only auditor/compliance tier — *RBAC, GRC*

**Security & data protection**
- A real secrets vault/KMS (every prod secret is plaintext in one host `.env`; one key signs sessions *and* encrypts data) — *CISO, DPO*
- Encryption at rest for Postgres and MinIO (plain Docker volumes; no SSE-KMS) — *CISO*
- Security response headers (CSP/HSTS/X-Frame-Options/helmet) — *CISO*
- Tamper-evident, append-only audit log (plain mutable table, best-effort writes swallowed on failure) — *CISO, GRC, AI-governance*
- Account lockout / distributed brute-force protection (in-memory per-instance limiter only) — *CISO, scale*
- Structural tenant isolation — Postgres RLS or Prisma query-extension (isolation is hand-written `WHERE organizationId` discipline) — *DPO*
- Dependency/container CVE scanning, SBOM, image signing, non-root containers, SAST in CI — *CISO, procurement*

**AI governance**
- A working human-in-the-loop approval gate (denies but never pauses/notifies/resumes) — *AI-governance*
- Enforced per-org approved-model allow-list on the actual execution path — *AI-governance*
- Data-egress governance (outbound domain allow-list, zero-retention/no-train posture, content-egress log, DLP/PII scan) — *AI-governance, DPO*
- Prompt-injection/jailbreak defenses + an instantaneous kill switch + agent-action rollback — *AI-governance*

**GRC & lifecycle**
- GDPR data-subject lifecycle: per-subject export (DSAR) + erasure/anonymization — *DPO, GRC*
- Tenant offboarding: per-org export + audited transactional hard-delete (no org-delete endpoint exists) — *DPO*
- Configurable retention, legal hold, eDiscovery export, SIEM/audit forwarding — *GRC, procurement*
- SOC 2 Type II / ISO 27001 / HIPAA posture, data-residency controls — *CISO, procurement*

**Reliability & deployment**
- Automated, off-host, tested backups + DR plan with stated RTO/RPO — *SRE, procurement*
- Metrics/tracing/alerting (`/metrics`, OpenTelemetry, paging) — *SRE*
- Versioned, registry-published images; Helm chart; real IaC for the Hetzner target; tested upgrade/rollback — *procurement, SRE*
- Connection pooler (PgBouncer) + horizontal-scaling story; load/capacity testing — *scale, SRE*

## Prioritized roadmap

Merged across personas; true deal-blockers first. Effort: S < 1wk, M ~1–4wk, L ~1–2mo, XL > 2mo (per item, rough).

| # | Item | Dimension | Severity | Effort | Why it matters |
|---|------|-----------|----------|--------|----------------|
| 1 | **Structural tenant isolation** — Postgres RLS or Prisma `$extends` org-scoping + CI lint forbidding un-scoped tenant queries; add cross-tenant test matrix | Multi-tenancy (DPO) | Critical | XL | Today isolation is ~1,200 hand-written `WHERE organizationId` clauses; one forgotten check (e.g. `openStream`'s global-UUID `findUnique`) is a reportable GDPR breach. No regulated deal clears without enforced-by-construction isolation. |
| 2 | **Secrets vault + envelope encryption + key split** — move secrets to Vault/KMS/SOPS, split JWT-signing key from data-encryption KEK, per-tenant DEKs (BYOK path), rotation runbook; land the throwing KMS placeholder | Security / Multi-tenancy (CISO, DPO) | Critical | L | Every prod secret is plaintext in one `.env`; one key both signs all sessions and encrypts all tenants' OAuth/push secrets. Host/CI/backup access = forge any session offline + decrypt every tenant. Hard procurement stop. |
| 3 | **Encryption at rest** — MinIO SSE-KMS + Postgres encrypted volumes + encrypted backups, documented key custody | Security (CISO) | Critical | M | Plain Docker volumes hold all PII, messages, KB, audit, password hashes. Stolen disk/snapshot/backup = total cleartext exposure. GDPR Art. 32 / HIPAA mandate it. |
| 4 | **Backups + tested restore + DR plan with RTO/RPO** — off-host encrypted `pg_dump`/WAL + MinIO replication, Postgres standby, host-loss runbook, executed restore drill | Reliability (SRE) | Critical | M | Single Hetzner box, single volume, zero backups; the disk already filled and crashed Postgres. One disk event = permanent loss of every tenant's data. Unanswerable on any CAIQ/SIG. |
| 5 | **SCIM 2.0 provisioning + deprovisioning** (Users + Groups, `active=false`) | Identity (IAM) | Critical | XL | At tens of thousands of churning identities, JIT-create + manual-deactivate guarantees orphaned accounts with live 30-day tokens. Fails access-recertification/offboarding controls on day one. |
| 6 | **Unify authorization on the policy engine** — fail-closed `authorize()` preHandler on all mutating routes + CI lint; fix the cross-tenant policy-binding IDOR; gate tasks/board/etc. on project/team membership; make `viewer` actually deny | RBAC (red-team) | Critical | XL | The advertised engine governs 4/47 routes; the rest use ad-hoc `requireOwner`. Any org member can read/edit/transition any task in any project; an owner of org A can mutate org B's policy bindings. Flat-within-org is not least-privilege. |
| 7 | **Tamper-evident, fully-covered audit log** — hash chain/HMAC + DB role REVOKE UPDATE/DELETE + blocking trigger; stop swallowing write failures; raise coverage to ~100% of privileged actions (auth/login, user/role, MCP, tool-grants, approvals, uploads, message edit/delete, per-tool agent invocations) enforced by CI | Audit / Security / AI-gov (GRC, CISO) | Critical | L | A mutable, best-effort, ~20%-covered log is not evidence. SOC 2 / ISO A.12.4 / FedRAMP AU require demonstrable integrity and completeness; an insider can rewrite history and "what did the AI do" is unanswerable. |
| 8 | **Working human-in-the-loop approval gate** — wire request → `waiting_approval` pause → notify approver → resume with proof; bind to a curated irreversible-builtin set | AI governance | Critical | L | The headline "human gate before irreversible agent actions" is vaporware: the gate denies and the agent barrels on. The resolve-half machinery is correct but orphaned. |
| 9 | **Enforce approved-model allow-list + data-egress governance** — require `enabled && approved` on the direct execution path (no env-key fallback); per-org outbound domain allow-list for `http_fetch`/MCP; zero-retention/no-train posture; content-egress log; pre-egress PII/DLP hook | AI governance / Privacy (AI-gov, DPO) | Critical | XL | Central third-party-egress risk: the model allow-list is decorative and an agent (or a prompt-injected one) can exfiltrate to any public host with no record of what corporate data left to whom. |
| 10 | **GDPR data-subject + tenant lifecycle** — per-subject DSAR export + erasure/anonymization (legal basis), per-org export + audited transactional hard-delete (purge storage prefix + secrets), records-of-processing register | GRC / Multi-tenancy (DPO, GRC) | Critical | XL | No org-delete, no export, no erasure exist. Cannot satisfy a 30-day DSAR, Art. 17/20, or a DPA. Hard legal blocker for EU/regulated procurement. |
| 11 | **Convert spend cap to enforceable** — pre-spend reservation with atomic/locked budget accounting, per-iteration mid-run gating with hard abort, regulated-tenant default that blocks humans; ship a seeded default price book + "cost-tracking healthy" signal | FinOps | High | L | The cap is advisory: N parallel runs all read the same under-cap total and overshoot ("runaway agent burns $50k overnight"), and cost is $0 until rates are hand-entered, so cost budgets silently never fire. |
| 12 | **Native SAML 2.0 SP** (SP metadata, ACS, signed-assertion validation, cert rotation, NameID mapping) + IdP group→role mapping (consume `mappingRules`) | Identity (IAM) | High | L | Half the regulated IdP estate is SAML-first; the enum is a placeholder. Without group→role mapping every SSO user lands as `member` and must be manually re-graded — unacceptable at scale. |
| 13 | **Observability + safe deploys** — `/metrics` (latency, error rate, queue depth/age, pool, spend) + OpenTelemetry with run-ID propagated across the queue + alerting (worker-down, dead-letter growth, disk >80%, deploy fail); build images in CI to a registry, gate promotion on `/api/health/ready`, auto-rollback, >1 API replica | Reliability (SRE) | High | L | "We have logs" is the entire story; nothing pages a human. Deploys build-on-host with no health gate or rollback and a guaranteed outage window every push. |
| 14 | **Connection pooler + horizontal-scaling + realtime fan-out fix** — PgBouncer, consolidate the 3 per-process pools, tune `max_connections`, `deploy.replicas`; cache per-connection channel visibility (kill the per-event uncached `findUnique` × all connections); index fan-out by channel | Scale | High | L | ~30+ connections/instance vs default 100 caps scaling at 2–3 replicas; realtime fan-out is O(connections × events) with a DB roundtrip each — p99 collapses at 10k users. |
| 15 | **Production image & supply-chain hardening** — non-root `USER`, digest-pinned bases, Trivy/Grype scan, SBOM (Syft/CycloneDX), Cosign signing, `pnpm audit` + CodeQL + Dependabot/Renovate in CI, documented patch SLA | Deployment / Security (procurement, CISO) | High | M | Root containers + floating tags + zero CI security gates won't pass admission control or a vendor-risk SBOM request; standing audit finding. |
| 16 | **Helm chart + real IaC + delete dead GCP Terraform + upgrade/rollback/version policy docs** | Deployment (procurement) | High | L | A single-VM compose snowflake with stale GCP Terraform as the only IaC fails an architecture review; can't run under GitOps or reproduce the estate declaratively. |
| 17 | **Distributed rate limiting + account lockout** — shared Postgres-backed limiter, per-account exponential backoff/lockout with audit, global default budget + per-route overrides, edge layer at Caddy | Security / Scale (CISO, scale) | High | M | In-memory per-instance limiter multiplies by replica count and resets on restart; no login lockout. Fails credential-stuffing/DoS controls. |
| 18 | **Retention, legal hold, eDiscovery + SIEM/outbound integration** — per-class retention with scheduled purge, legal-hold override, signed eDiscovery bundle; audit-log SIEM forwarder (S3/syslog/CEF); outbound HMAC-signed webhooks; OpenAPI 3 spec | GRC / Deployment (GRC, procurement) | High | L | "Indefinite, no purge" is itself a storage-limitation problem; regulated buyers need 7/10-year retention, freeze-for-case-X, and SOC tooling integration. |
| 19 | **Kill switch + agent-action rollback + prompt-injection defenses + full-fidelity replay** — durable `Agent.enabled` + org-wide `aiEnabled` checked at run admission; compensating actions for reversible builtins; fence untrusted tool/web/KB content as data + injection classifier + output moderation; persist prompts + full tool I/O for replay | AI governance | High | L | Must assume the agent gets tricked: no instant halt, no undo, no input/output screening, and truncated/summary-only tool I/O means no forensic replay. |
| 20 | **Retention/partitioning for unbounded tables + read replica + load harness** — prune/partition `thread_stream_events` and terminal `queue_jobs`; route heavy reads to a replica; guard `pg_notify` 8KB payloads; k6 harness + published capacity envelope | Scale | High | L | `thread_stream_events` (one row per token) and done `queue_jobs` grow without bound and degrade the queue/replay indexes; one Postgres does OLTP+queue+pub/sub+pgvector with no measured breaking point. |
| 21 | **Compliance program + finance/auditor roles + chargeback/seat metering** — SOC 2 Type I→II scoping, data-residency design; read-only finance + auditor roles; CSV/API chargeback export with date range + cost-center tag; estimate-vs-invoice reconciliation; seat/MAU metering; dual-control on role/policy changes | GRC / FinOps / RBAC | Medium | XL | No certification, no read-only compliance tier (audit log is owner-only), no chargeback export, no contractual seat metric, and a single owner can self-escalate with no witness. |

## Quick wins

High-value, low-effort (S/M) items that can ship soon:

- **Security headers** — strict CSP + HSTS + `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff` + `Referrer-Policy` at the admin nginx/Caddy edge, and register `@fastify/helmet` on the API. (CISO, S)
- **Route OIDC fetches through the existing SSRF guard** — `assertSafeUrl` on `issuerUrl`, `token_endpoint`, `userinfo_endpoint`; pin/allowlist issuer hosts. The guard already exists; it's just not called here. (CISO, S)
- **CI supply-chain gates** — add `pnpm audit --audit-level=high`, Dependabot/Renovate, CodeQL, and Trivy image scan; these are config-only additions to `ci.yml`. (CISO/procurement, S→M)
- **Fix the cross-tenant policy-binding IDOR** — org-scope the rule/binding lookups in `policy.ts` (`findFirst({ where: { id, organizationId } })`) and add a regression test. Small, high-severity correctness fix. (RBAC, S)
- **Non-root containers + digest-pinned base images** — add `USER node`/non-root nginx and pin `node:22-slim`/`minio:latest` by digest. (procurement, S→M)
- **Per-container resource limits** — `mem_limit`/`cpus` on api/worker/postgres/minio so a runaway run can't take down the shared host. (SRE, S)
- **Wire the existing readiness probe into deploys** — post-deploy `/api/health/ready` curl with rollback-on-failure; the probe already exists, the deploy just ignores it. (SRE, S→M)
- **Seeded default price book + "cost-tracking healthy" warning** — turns every cost/budget from inert-$0 to correct out of the box. (FinOps, M)
- **Idle/inactivity session timeout** — enforce on the already-tracked `lastUsedAt`. (IAM, S)
- **Connect the orphaned approval resolve-half** — the resolution logic (no self-approval, live role re-check, atomic claim, TTL) is correct; wiring it to the gate (#8) is the remaining work. (AI-gov, the resolve side is S once #8 lands)

## Biggest risks

The few things most likely to lose an enterprise deal or cause a breach/outage:

1. **Cross-tenant data leak from discretionary isolation (#1).** Isolation is ~1,200 hand-written `WHERE` clauses with no RLS/middleware backstop; the `openStream` global-UUID fetch is the canonical near-miss. One forgotten clause is a reportable multi-tenant GDPR breach — the single highest-probability catastrophic security event.
2. **Total secret compromise from the plaintext `.env` + single master key (#2).** One key signs every session *and* encrypts every tenant's secrets, in cleartext on one host. Any host/CI/backup access forges any user's session offline and decrypts all tenants. This alone fails procurement.
3. **Permanent data loss (#3, #4).** No backups, no encryption at rest, single volume on a box that has *already* crashed on disk exhaustion. A disk failure, bad migration, or stolen snapshot is unrecoverable and/or a cleartext exposure of everything.
4. **Ungoverned autonomous AI (#8, #9, #19).** A broken human gate + decorative model allow-list + unbounded egress + no prompt-injection defense + no kill switch + no rollback means a single poisoned web page or document can redirect an agent to exfiltrate data and take irreversible actions, with no human able to stop it and no forensic replay afterward.
5. **Orphaned access at scale (#5).** JIT-only provisioning with manual deactivation guarantees that leavers retain live accounts and valid refresh tokens until a human notices — a direct failure of the access-recertification and offboarding controls every regulated customer audits.
6. **Unmeasured scale ceiling + audit unprovability (#6, #7, #14).** The policy engine governs 4/47 routes (latent authz bypass), the audit log is mutable and ~20% covered (no defensible trail), and the connection budget + realtime fan-out cap real-world capacity at a few hundred to low-thousands of concurrent users — none of which has been load-tested, so no SLA or sizing commitment is possible.

---

# Appendix — full per-persona assessments

## Security posture & compliance certification readiness

*Persona: Bank CISO (assume-breach)*

## Maturity
partial

## Current State
- Stateless HS256 session JWTs (30-min TTL) plus a separate opaque, hashed, family-rotated refresh-token system with reuse detection and per-session revocation — `api/src/auth/session.ts:29-84`, `api/src/services/refresh-token.ts:63-101,117-153`.
- Refresh token cookie is `httpOnly`, `Secure` (non-local), `SameSite=None`, path-scoped to `/api/auth`; only the SHA-256 hash is persisted — `api/src/lib/refresh-cookie.ts:11-16`, `api/src/services/refresh-token.ts:8-11`.
- Passwords hashed with scrypt + 16-byte random salt and constant-time compare — `api/src/auth/password.ts:8-27`. Session signature verified with `timingSafeEqual` — `api/src/auth/session.ts:67-72`.
- A real SSRF guard exists and is reused (not duplicated): scheme allowlist, credential-in-URL block, blocked hostnames (localhost/metadata), IPv4/IPv6 private/link-local/reserved ranges, and post-DNS-resolution IP re-check — `packages/runtime/src/url-safety.ts:76-119`; worker re-exports it — `worker/src/run/builtin-handlers/url-safety.ts`. Wired into MCP connector save/use and worker HTTP fetch — `api/src/services/mcp-security.ts:47-105`, `worker/src/run/builtin-handlers/http-fetch.ts:123`, `worker/src/run/tool-mcp.ts:52`.
- MCP stdio transport is hard-disabled for user connectors; model `backends` config rejects non-https and localhost/metadata URLs — `api/src/services/mcp-security.ts:69-73`, `packages/config/src/index.ts:45-57`.
- Secrets at rest for MCP OAuth tokens and push credentials use AES-256-GCM keyed off the auth secret; production refuses the in-memory stub — `packages/runtime/src/secret-crypto.ts:14-52`, `docs/deployment.md:286-295`.
- CORS is an explicit allowlist with a single source of truth shared by REST and hijacked-SSE paths; `methods` pinned to avoid the v11 safelist trap — `api/src/lib/server-context.ts:82-126`, `api/src/index.ts:205-215`.
- Reverse-proxy trust is explicit (`X-Forwarded-For` honored only when `trustedProxyHops>0`) — `api/src/lib/server-context.ts:142-148`, `api/src/index.ts:113`.
- Tenant-scoped audit log with actor/resource/outcome/IP/UA/requestId, sensitive-field redaction, and indexed query API — `api/src/services/audit.ts:4-74`, `api/prisma/schema.prisma:2097-2119`.
- OIDC login implements PKCE (S256) + `state`; UOA SSO uses a signed RS256 config-JWT flow — `api/src/services/external-auth.ts:80-85`, `docs/deployment.md:303-365`.
- TLS in transit terminated automatically at the shared Caddy edge (Let's Encrypt) — `docs/deployment.md:8-11`.

## Gaps

### No secrets vault — all production secrets are plaintext in a host `.env` file
- Severity: critical
- Effort: L
- Description: Every production secret — `NESSIE_AUTH_SECRET` (which signs all sessions AND is the master encryption key for OAuth/push secrets), the Postgres password, MinIO root credentials, and OpenAI/model keys — lives as plaintext environment variables sourced from a single `/srv/nessie/.../.env` on the Hetzner host. There is no Vault/KMS/secrets-manager, no envelope encryption, no rotation, and no separation between the signing key and the data-encryption key. Anyone with host/root access (a contractor, a backup, a compromised CI deploy key) reads every secret and can forge any user's session offline. My security review fails this outright: a regulated bank requires HSM/KMS-backed key management with documented rotation and split-knowledge. The project's own spec admits it: "No first-class secret vault exists yet... reads provider keys from process env."
- Evidence: `infrastructure/compose/.env.prod.example:9-12,42-44`; `infrastructure/compose/docker-compose.prod.yml:87-106`; `packages/config/src/index.ts:131-162` (env-only sourcing); `docs/deployment.md:256` (one secret signs sessions and encrypts MCP secrets); `docs/secret-management-spec.md:313-318` ("No first-class secret vault exists yet"). KMS only exists in retired GCP terraform — `infrastructure/terraform/modules/kms/main.tf` — not in the live Hetzner path.
- Recommendation: Introduce a real secrets backend (HashiCorp Vault / cloud KMS / SOPS-with-KMS at minimum), split the JWT-signing key from the data-encryption KEK, implement envelope encryption (KEK→DEK) for the `mcp_oauth_secret` store, and document a rotation runbook. Until then, no enterprise procurement clears this.

### No encryption at rest for the database or object storage
- Severity: critical
- Effort: M
- Description: Postgres (containing all messages, KB content, PII, audit logs, password hashes) and MinIO (all uploaded files/attachments) write to plain Docker named volumes with no encryption configured — no SSE-S3/SSE-KMS on MinIO, no transparent DB encryption, no LUKS/dm-crypt requirement documented. A stolen disk, a snapshot leak, or backup exfiltration exposes everything in cleartext. GDPR Art. 32, HIPAA, and every bank's data-protection standard mandate encryption at rest with managed keys; "it's on a Hetzner box" is not a control I can evidence to an auditor.
- Evidence: `infrastructure/compose/docker-compose.prod.yml:16-58,201-203` (plain `nessie_pgdata`/`nessie_miniodata` volumes, no encryption env); `docs/deployment.md:266-283` (storage section — no at-rest encryption mentioned). Searched compose/docs for `sse-s3`, `sse-kms`, `luks`, `encrypt.*at.rest` — found nothing in the live path.
- Recommendation: Enable MinIO SSE-KMS (KES + external KMS), enable Postgres at-rest encryption (encrypted volume / cloud-managed encrypted storage), encrypt backups, and document the key custody chain.

### No security response headers anywhere (no CSP, HSTS, X-Frame-Options, etc.)
- Severity: high
- Effort: S
- Description: The admin nginx serves the SPA with zero security headers, the API registers no helmet/CSP, and the deployment docs show no header config on Caddy. That means no Content-Security-Policy (the admin renders user/agent-authored content and is a stored-XSS target), no HSTS (TLS downgrade/SSL-strip), no X-Frame-Options/`frame-ancestors` (clickjacking), no X-Content-Type-Options, no Referrer-Policy. These are table-stakes findings that every external pentest and every bank vendor questionnaire flags on the first pass.
- Evidence: `infrastructure/docker/admin-nginx.conf:1-30` (only cache headers, no security headers); `api/src/index.ts:18-22,205-223` (no `@fastify/helmet` import or registration); searched `infrastructure/` and `docs/deployment.md` for `Strict-Transport`, `Content-Security`, `X-Frame`, `helmet` — found nothing.
- Recommendation: Add a strict CSP + HSTS + `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff` + `Referrer-Policy` at the admin nginx and/or Caddy edge, and register `@fastify/helmet` on the API.

### Audit log is mutable — no tamper-resistance, WORM, or integrity chain
- Severity: high
- Effort: M
- Description: The audit log is an ordinary Postgres table with no hash chain, no per-row signature, no append-only/WORM enforcement, and no external sink. Anyone with DB write access — a DBA, a SQL-injection foothold, or the app's own service account — can silently UPDATE or DELETE audit rows to erase their tracks, and there is no way to prove the log is complete or unaltered. SOC 2, ISO 27001 A.12.4, and FedRAMP AU controls all require demonstrable audit integrity. A trail an insider can rewrite is not evidence I can present. Additionally, audit emission is best-effort and swallowed on failure, so a write can be silently lost.
- Evidence: `api/prisma/schema.prisma:2097-2119` (plain table, no integrity columns); `api/src/services/audit.ts:45-74` (plain `create`, catch-and-swallow on failure — "Audit emission must never roll back the primary mutation").
- Recommendation: Add a per-org hash chain (each row hashes the prior row + payload) or row signatures, ship audit events to an append-only external sink (e.g. immutable object store / SIEM), and restrict DB grants so the app role cannot UPDATE/DELETE `audit_logs`.

### No account lockout / brute-force protection; auth rate-limit is in-memory and per-instance
- Severity: high
- Effort: M
- Description: Password login has no per-account failed-attempt tracking or lockout (the only `lockedUntil` in the schema is on the job-queue table, not users). The sole defense is an in-process `Map`-based IP rate limiter of 10 attempts/10 min — but it is per-process, so once the API scales beyond one container (and the stack is built to run API + worker + horizontal scale), an attacker simply spreads attempts across instances or rotates IPs, and a restart wipes all counters. There is no distributed limiter despite the deployment being Postgres-backed and explicitly Redis-free. That fails any credential-stuffing/brute-force control review.
- Evidence: `api/src/lib/server-context.ts:520-565` (in-memory `rateLimitBuckets` Map, lost on restart, not shared across instances); `api/src/routes/auth.ts:471-473` (login: verify-or-401, no attempt counter, no lockout); `api/prisma/schema.prisma:2005` (`lockedUntil` is on a queue/job row, not the user). Searched code for `lockedUntil`/`failedLogin`/`lockout` against the user model — no enforcement found.
- Recommendation: Move rate limiting to a shared Postgres-backed store, add per-account exponential backoff + lockout with audit events, and add CAPTCHA/step-up after N failures.

### Outbound SSRF guard not applied to OIDC discovery/token/userinfo fetches
- Severity: medium
- Effort: S
- Description: The SSRF guard is correctly enforced on MCP and agent HTTP tools, but the OIDC/external-auth code path calls `fetch()` directly against an admin-configured `issuerUrl` and against `token_endpoint`/`userinfo_endpoint` URLs taken verbatim from the discovery document — none of which pass `assertSafeUrl`. A malicious or compromised provider config (or a tampered discovery doc) can point these at `169.254.169.254` or internal services, turning the server into an SSRF pivot. In a regulated environment where provider onboarding may be self-service or delegated, this is a real internal-network reach.
- Evidence: `api/src/services/external-auth.ts:49,107,130` (raw `fetch` on `buildDiscoveryUrl(issuerUrl)`, `discovery.token_endpoint`, `discovery.userinfo_endpoint` with no `assertSafeUrl`). Contrast with `api/src/services/mcp-security.ts:47-62` which does guard.
- Recommendation: Route every external-auth fetch through `assertSafeUrl`, and pin/allowlist issuer hosts.

### No dependency or container vulnerability management in CI; no SAST
- Severity: medium
- Effort: S
- Description: CI runs lint, typecheck, build, and tests only — there is no `pnpm audit`, no Dependabot/Renovate, no SAST (CodeQL), and no container image scanning (Trivy/Grype). There is no documented patch SLA. For a supply-chain-conscious bank, "we don't scan dependencies or images" is a standing audit finding and blocks the vendor-risk assessment.
- Evidence: `.github/workflows/ci.yml:11-145` (no audit/scan steps); no `.github/dependabot.yml` (confirmed absent); searched `.github/` for `dependabot/snyk/trivy/codeql/osv/grype` — found nothing.
- Recommendation: Add Dependabot/Renovate, a `pnpm audit --audit-level=high` gate, CodeQL, and Trivy image scanning to CI, with a documented remediation SLA.

### No compliance evidence, data-residency controls, or SSO breadth (SAML)
- Severity: medium
- Effort: L
- Description: There is no SOC 2 / ISO 27001 / HIPAA / FedRAMP posture, no data-residency/region pinning (single Hetzner host; the spec lists residency only as an open question), and primary SSO is a single proprietary provider (UOA) — `saml` is in the config enum but `external-auth.ts` only handles OIDC/UOA, so there is no real SAML for enterprise IdPs. The secret-management spec, which underpins residency and step-up, is explicitly target-state Phase 3. A bank's IAM and data-sovereignty requirements are unmet today.
- Evidence: `docs/secret-management-spec.md:296-297,314-318` (residency/region listed as open questions; vault unbuilt); `packages/config/src/index.ts:8-14` (`saml` in enum) vs `api/src/services/external-auth.ts:36-40` (only `custom`/`oidc`/`uoa` accepted — SAML unimplemented). No SOC2/ISO/HIPAA/FedRAMP doc exists — searched `**/security*.md`, `*compliance*`, `*soc2*`, `*pentest*`, found only an in-progress worktree audit.
- Recommendation: Stand up a compliance program (start with SOC 2 Type I scoping), implement SAML for enterprise IdPs, and design region/data-residency controls before pursuing regulated customers.

## Top Priorities
- Stand up a real secrets backend (Vault/KMS) with envelope encryption and key rotation, and split the JWT-signing key from the data-encryption KEK — today every secret is plaintext in one host `.env` and one key does everything (`docs/deployment.md:256`, `docs/secret-management-spec.md:313-318`).
- Turn on encryption at rest for Postgres and MinIO (SSE-KMS / encrypted volumes / encrypted backups) — currently plain Docker volumes (`infrastructure/compose/docker-compose.prod.yml:201-203`).
- Make the audit log tamper-evident (hash chain / signed rows / append-only external sink + locked-down DB grants) and add account-lockout brute-force protection backed by a shared store, not an in-memory per-instance Map (`api/src/services/audit.ts:45-74`, `api/src/lib/server-context.ts:520-565`).
- Close the quick wins: add security headers (CSP/HSTS/X-Frame-Options) at the edge and `@fastify/helmet`, run the OIDC fetches through the existing SSRF guard, and add dependency/container scanning to CI (`infrastructure/docker/admin-nginx.conf`, `api/src/services/external-auth.ts:49,107,130`, `.github/workflows/ci.yml`).

## Enterprise identity: SSO breadth, SCIM provisioning, MFA

*Persona: Enterprise IAM architect (joiner/mover/leaver)*

## Maturity
early

## Current State
- OIDC Authorization Code + PKCE (S256) login against any discovery-document IdP: builds the authorize URL with `code_challenge`/`code_challenge_method=S256` and exchanges the code at the token + userinfo endpoints (`api/src/services/external-auth.ts:60-154`). Provider types accepted at runtime are `oidc`, `custom`, and `uoa` only (`api/src/services/external-auth.ts:34-42`).
- Just-in-time SSO provisioning: a first-time SSO user with no local account is auto-created (or bootstraps the default org as owner on a fresh instance) on successful code exchange (`api/src/routes/auth.ts:352-397`).
- Short-lived HS256 access token (30 min) + rotating opaque refresh token (30 days) in an httpOnly cookie, with rotation-family reuse detection that revokes the whole family on replay (`api/src/services/refresh-token.ts:63-153`; TTLs `packages/config/src/index.ts:69-70`).
- Self-service session lifecycle: list active sessions and revoke a single session, scoped to the caller's own `userId` (`api/src/routes/auth.ts:627-662`; `api/src/services/refresh-token.ts:181-229`).
- Reversible membership deactivation: `OrganizationMember.deactivatedAt` denies access and a still-valid access token is rejected mid-session (`api/prisma/schema.prisma:685-688`; enforcement at `api/src/lib/server-context.ts:300-303`); owner-only deactivate/reactivate endpoints with a last-owner guard (`api/src/routes/users.ts:123-167`).
- Owner-managed local user CRUD with a four-tier role enum (`owner | admin | member | viewer`) (`api/prisma/schema.prisma:224-229`; `api/src/routes/users.ts:38-121`).
- UnlikeOtherAI (UOA) hosted-login adapter: signed config JWT + published JWKS at `/.well-known/jwks.json` (`api/src/routes/auth.ts:89-109`).

## Gaps

### No SAML 2.0 support — OIDC only
- Severity: critical
- Effort: L
- Description: Half the regulated-enterprise IdP estate I run is SAML-first. The codebase advertises `saml` as a provider type but it is a dead enum value: the only login code path is the OIDC discovery-document flow, and the provider guard explicitly throws on anything that is not `oidc`/`custom`/`uoa`. There is no SP metadata endpoint, no ACS (assertion consumer) URL, no assertion signature validation, no SAML library. The spec itself concedes SAML is only "via gateway/adapter" — i.e. you expect me to stand up a separate translation proxy, which is another box to security-review, patch, and own. For an Entra/Okta SAML app this is a hard procurement stop.
- Evidence: `packages/config/src/index.ts:8-13` and `packages/schemas/src/identity.ts:12-18` declare `saml`; `api/src/services/external-auth.ts:34-42` rejects every non-OIDC type; `docs/deployment-modes-and-auth-spec.md:115` says "SAML via gateway/adapter"; absent: searched `api/src`, `worker/src`, `packages/*/src` for `saml`/ACS/SP-metadata/assertion handling, found only the enum declarations.
- Recommendation: Implement native SAML 2.0 SP (SP metadata, ACS endpoint, signed-assertion validation with cert rotation, NameID→user mapping) via a vetted library, or at minimum ship and support a documented, hardened SAML→OIDC adapter as a first-class component — not a hand-wave.

### No SCIM 2.0 provisioning or deprovisioning — orphaned accounts guaranteed
- Severity: critical
- Effort: XL
- Description: This is my single biggest objection. With tens of thousands of identities churning monthly, lifecycle MUST be driven from Okta/Entra over SCIM: create on join, update on team move, **deactivate on leave**. Nessie has no SCIM endpoint at all — no `/scim/v2/Users`, no `/Groups`, no PATCH op handling. The only provisioning is lazy JIT at login, which means an account is born only when someone logs in and is **never** removed when HR offboards them. Deactivation exists solely as a manual owner clicking a button per user (`POST /api/users/:id/deactivate`). At 40k users a leaver keeps a live account (and a 30-day refresh token) until a human notices. That fails an access-recertification audit and an SOC 2 / ISO offboarding control on day one.
- Evidence: absent: searched `api/src` routes for `/scim`, `scim/v2`, `patchOp`, provisioning endpoints — found nothing; provisioning is JIT-only at `api/src/routes/auth.ts:352-397`; deprovisioning is manual-only at `api/src/routes/users.ts:123-149`.
- Recommendation: Build a SCIM 2.0 server (Users + Groups, with `active=false` deprovisioning and PATCH semantics) authenticated by a per-tenant bearer token, mapping IdP group membership to org/team membership and roles. This is table stakes; nothing else in this report matters if a leaver's access doesn't revoke automatically.

### No IdP group → role mapping (provisioned users are hardcoded `member`)
- Severity: high
- Effort: M
- Description: Access must follow group membership: "Finance-Admins" → admin, contractors → viewer. Nessie's OIDC exchange extracts only `email`/`name`/`picture` and discards everything else — it never reads a `groups` or `roles` claim. JIT-provisioned SSO users are hardcoded to `role: 'member'`. The config schema even has a `mappingRules` field, but it is dead: nothing in the codebase ever reads it. So every SSO user lands as a generic member and an owner must manually re-grade thousands of people — exactly the manual user management that is unacceptable at scale.
- Evidence: `api/src/services/external-auth.ts:140-154` returns only email/displayName/avatar; hardcoded `role: 'member'` at `api/src/routes/auth.ts:392`; `mappingRules` declared at `packages/config/src/index.ts:26` but grep across `api/src`/`worker/src` shows no consumer (only `claims.roles` echoes the session token, `api/src/services/auth.ts:72`).
- Recommendation: Read the configured groups/roles claim during OIDC exchange and apply `mappingRules` (group → org role) on both first provisioning and every subsequent login so role changes track IdP group changes; this also becomes the backbone for SCIM `Groups`.

### No login MFA / step-up enforcement in the product
- Severity: high
- Effort: M
- Description: A regulated security review asks "can you enforce MFA / step-up for privileged actions." Nessie delegates MFA entirely to the upstream IdP for SSO and offers a bare local email+password path with no second factor. There IS a `VerificationFactorType` enum (`totp`, `webauthn`, `email_otp`, …) and an optional `verification` block on the authorized-action context — but it is dead schema: nothing issues a challenge, verifies a proof, or requires it. The policy engine has no `verification` consumer. So there is no MFA enforcement, no step-up for approvals/destructive ops, and no way to assert factor strength. For the local-password accounts that ship by default this is a single-factor system.
- Evidence: factor enum + optional `verification` field at `packages/schemas/src/access-context.ts:15-22,70-77`; grep for `challengeId`/`issueChallenge`/`verifyChallenge`/`stepUp` across `api/src`, `worker/src`, `packages/policy/src` found no implementation; local login is password-only at `api/src/routes/auth.ts:464-501`.
- Recommendation: Either enforce that local accounts are disabled in selfHosted/hosted mode (SSO-only, relying on IdP MFA and surfacing the `amr`/`acr` claim), or implement real TOTP/WebAuthn enrolment + step-up gating on privileged actions using the existing schema, and record the auth-method/factor in the session for policy decisions.

### No API keys / service accounts for users or automation
- Severity: high
- Effort: M
- Description: Enterprise integrations (CI, ETL, SIEM pulls, an SRE script) need non-interactive credentials that are scoped, attributable, individually revocable, and rotatable — owned by a service account, not a human's SSO session. Nessie has no user/service-account API-key model. The only API keys in the system are per-trigger webhook secrets stored in trigger config and compared by hand; they are not identities, carry no RBAC, and don't appear in the user/audit model. So every programmatic caller today has to ride a human's 30-minute access token (un-rotatable, tied to a person who will eventually leave), which is exactly the orphaned-credential problem I'm paid to eliminate.
- Evidence: absent: searched `api/src`/`packages/*/src` for `apiKey`/`serviceAccount`/`personal access token` models — only webhook secrets exist (`api/src/routes/trigger-intake.ts:122-163`; `api/src/contracts/triggers.ts:35`); no `ApiKey`/`ServiceAccount` Prisma model (`api/prisma/schema.prisma` has only `User`/`RefreshToken`/`OrganizationMember`).
- Recommendation: Add a first-class API-key / service-account model (hashed secret, scopes/roles, owner, `expiresAt`, last-used, revoke + rotate endpoints), surfaced in the admin and the audit log, so automation has its own revocable identity decoupled from human lifecycle.

### Single global auth config; no idle timeout or admin-driven SSO setup
- Severity: medium
- Effort: M
- Description: Two operational gaps an SRE/IT team will hit. (1) SSO providers are read from process env (`auth.providers` defaults to `[]`) and applied process-wide — there is no per-tenant IdP and no admin UI to add/rotate an SSO connection; onboarding or rotating an IdP means an env change and a redeploy, which doesn't fit a self-service tenant model or a credential-rotation SLA. (2) Sessions have only an absolute TTL (30-min access, 30-day refresh) — there is no inactivity/idle timeout, which most regulated session-management policies (e.g. 15-min idle) mandate; `listUserSessions` tracks a `lastUsedAt` but nothing expires on it.
- Evidence: env-only provider config at `packages/config/src/index.ts:64,191` and env keys `NESSIE_AUTH_*` at `:133-136`; admin has no SSO/SCIM config surface (grep of `admin/src` for `scim`/`saml`/`provisioning` returns only a display label in `SettingsProfilePage.tsx:16`); TTLs are absolute-only at `packages/config/src/index.ts:69-70`, no idle-timeout logic in `api/src/services/refresh-token.ts` or `api/src/lib/server-context.ts`.
- Recommendation: Move SSO/SCIM connections into per-tenant DB config with an admin UI (add/test/rotate without redeploy) and add a configurable idle-timeout that revokes/forces re-auth on inactivity using the already-tracked `lastUsedAt`.

## Top Priorities
- Ship SCIM 2.0 (Users + Groups, with `active=false` deprovisioning) so joiner/mover/leaver lifecycle is automatic — this is the deal-blocker; JIT-only provisioning with manual deactivation cannot survive 40k churning identities.
- Add native SAML 2.0 SP support (or a first-class, supported adapter) — OIDC-only excludes a large share of regulated-enterprise IdP estates and the current `saml` enum value is a non-functional placeholder.
- Implement IdP group → role mapping by consuming the groups claim and the already-declared `mappingRules`, so access tracks group membership instead of every SSO user landing as a hardcoded `member`.
- Introduce service-account API keys (scoped, revocable, rotatable, attributable) so automation stops borrowing human sessions, and add login MFA enforcement / step-up by wiring the dead `VerificationFactorType` schema.

## RBAC depth, authorization correctness, admin tiers

*Persona: Offensive red-teamer (authz bypass)*

## Maturity
partial

## Current State
- A real deny-overrides policy engine exists: rules are sorted by scope weight (org→project→team→channel→agent→tool→user) then priority, with deny short-circuiting and allow-as-last-wins (`api/src/services/policy.ts:99-172`, `resolveDecision`). It supports `requiresApproval` and `timeWindow` conditions (`api/src/services/policy.ts:41-64,144-153`).
- The engine is genuinely scope-chained and tenant-scoped: every query filters `pr.organization_id = orgId` and `scope_id IN (chain)` (`api/src/services/policy.ts:185-196`), and supports single, batch, and effective-policy evaluation (`checkPolicy`, `checkPolicyBatch`, `getEffectivePolicy`).
- Policy CRUD is owner-gated and rule mutations are correctly org-scoped (`where: { id: ruleId, organizationId }` in `updatePolicyRule`/`deletePolicyRule`, `api/src/services/policy.ts:416-437`), with audit events emitted on create/update/delete (`api/src/routes/policy.ts:98-153`).
- Worker re-evaluates policy at tool-invocation time as a second layer, after a deny-by-default tool-grant gate (`worker/src/run/execute/agent-loop.ts:273-308`; grant gate returns `tool_not_granted` by default in `worker/src/run/tool-policy.ts:32-47`).
- Worker validates that the run's actor context matches the execution context (org/channel/agent/task/thread) and refuses on mismatch, with an audit record (`worker/src/run/execute/policy.ts:266-329`).
- Membership-role vocabulary is enforced at the DB layer via the `MemberRole` enum (`owner|admin|member|viewer`) and re-validated on writes (`api/prisma/schema.prisma:224-229`, `resolveMembershipRole` in `api/src/lib/server-context.ts:374-381`).
- Super-admin is a `users.super_admin` flag resolved from the DB (not from session roles) and sits above per-org `owner` (`api/src/lib/server-context.ts:349-369`); it gates the platform-push surface (`api/src/routes/platform-push.ts`).
- Approvals implement a separation-of-duties primitive: the requester cannot approve their own request, an optional `requiredApproverRole` is enforced, and a race for the same approval is handled (`api/src/services/approvals.ts:140-141,149-159,176-183`).
- Deactivated members are rejected even with a still-valid access token (`api/src/lib/server-context.ts:293-305`), and the last active owner cannot be demoted or deactivated (`api/src/routes/users.ts:111-116,141-144`).
- Channel management authority is derived from channel/team/org role (`canManageChannel`, `api/src/services/channels.ts:190-214`).

## Gaps

### Two parallel, divergent authorization systems — the policy engine is bypassed by ~91% of routes
- Severity: critical
- Effort: XL
- Description: As a red-teamer, my first move is to find where the advertised control plane is NOT in the request path — and here it mostly isn't. Only 4 of 47 API route files (`agents.ts`, `knowledge-base-access.ts`, `triggers.ts`, `policy.ts`) ever invoke the deny-overrides engine. Every other route authorizes with ad-hoc role-string checks (`requireOwner`, `roles?.includes('owner')`) or bespoke membership lookups. So the "scoped RBAC policy engine with deny-overrides" that a security review will be told about governs almost nothing: tasks, board, projects, teams, users, ledger, audit-log, MCP, workflows, calls, search, etc. are all governed by hand-rolled `owner`/membership checks, not by org-configurable policy. An org admin cannot express "deny exports of channel X to role Y" and have it enforced on the export route, because the route never asks the engine. This is the classic "policy engine exists, therefore it must be applied" trap — and it isn't. Two systems that must agree but are maintained independently is exactly where the next authz bypass will live.
- Evidence: `grep` shows `checkPolicy`/`checkPolicyBatch` referenced only in `api/src/routes/{agents,knowledge-base-access,triggers,policy}.ts`; the other 43 route files in `api/src/routes/` use `requireOwner`/role strings (e.g. `api/src/routes/tasks.ts`, `board.ts`, `users.ts`, `audit-log.ts`). The two evaluators are even duplicated (`api/src/services/policy.ts` vs `worker/src/run/execute/policy.ts`) and already differ (see next gap).
- Recommendation: Make the policy engine the single chokepoint. Introduce a route-level `authorize(resourceType, action, scopeIds)` preHandler that all routes must call, fail-closed by default, and delete the parallel `requireOwner`-only enforcement except as an `owner→admin:admin` policy rule. Add a CI lint that fails any route handler with a DB mutation that has no `authorize()` call.

### Flat within-org access: tasks (and similar resources) ignore project/team membership entirely
- Severity: high
- Effort: M
- Description: Inside one tenant there is effectively no least-privilege. Every task service function scopes by `organizationId` only — never by project membership, team membership, or task ownership. So a `viewer` or `member` who belongs to Project A can `GET /api/tasks/:taskId`, `PATCH`, `transition`, `assign`, and `move` any task in Project B of the same org. For a 10,000-seat regulated customer with sensitive projects (M&A, legal, security), this is horizontal data exposure and tamper across project boundaries — and the `viewer` role grants no actual read-only restriction on these mutating routes (they only gate on `requireUserActor`, not role). The policy engine even *has* a `task` resource type that is never consulted.
- Evidence: `api/src/services/tasks.ts` — every `where` clause is `{ id, organizationId }` with no `projectMember`/`teamMember` join (lines 132, 154, 254, 321, 365, 408, 504); routes only call `requireUserActor`, not any role/membership/policy check (`api/src/routes/tasks.ts:117-288`). `task` is a declared `PolicyResourceType` (`api/src/services/policy.ts:271`) but no task route calls `checkPolicy`.
- Recommendation: Gate task (and equivalent resource) access on project/team membership and ownership, routed through the policy engine's `task` resource type. The `viewer` role must actually deny mutating actions.

### Cross-tenant policy-binding manipulation (IDOR on policy bindings)
- Severity: high
- Effort: S
- Description: The binding endpoints take an attacker-supplied `ruleId`/`bindingId` and never verify the target rule belongs to the caller's organization. `requireOwner` only confirms the caller is an owner of *their own* org. `addPolicyBinding`/`removePolicyBinding` issue `prisma.policyBinding.create/delete` with no `organizationId` filter. So an owner of org A can POST a binding onto a policy rule owned by org B, or DELETE a binding from org B's rule — directly mutating another tenant's authorization rules (e.g. strip a deny binding, or attach `actorId: '*'` to an allow). This is a cross-tenant integrity flaw in the one subsystem that is supposed to be the authority on access.
- Evidence: `api/src/routes/policy.ts:157-177` (no org lookup of the rule), `api/src/services/policy.ts:439-456` (`policyBinding.create` and `policyBinding.delete({ where: { id } })` with no org scoping). Contrast with the correctly-scoped `updatePolicyRule`/`deletePolicyRule` at `api/src/services/policy.ts:406-437`.
- Recommendation: In both binding endpoints, first load the rule with `findFirst({ where: { id: ruleId, organizationId } })` and 404 if absent; scope `removePolicyBinding` by joining the binding to a rule in the actor's org. Add a regression test in the existing cross-tenant test suite.

### Role tiers are inconsistent and the `admin`/`viewer` roles are semantically incoherent
- Severity: high
- Effort: L
- Description: The product advertises four roles (`owner|admin|member|viewer`) but they don't mean one consistent thing. The default seed policies and almost all route guards only privilege `owner` (`requireOwner` checks `roles.includes('owner')`), so an org `admin` cannot manage users, read the audit log, write policy, or manage the board — yet `admin` *is* treated as privileged for channel management (`channels.ts`) and org-profile edits (`organizations.ts` `ADMIN_ROLES = {owner, admin}`). `viewer` is enforced for channel visibility but is ignored on task/board mutation routes. A buyer's IAM team cannot reason about "what can an admin do?" because the answer is route-by-route. There are also no custom/configurable roles and no delegation: roles are hard-coded strings with no Role table (`schema.prisma:1872-1874` explicitly notes "no Role table exists"), so a regulated customer cannot model their own job functions (e.g. "Compliance-ReadOnly", "Project-Lead").
- Evidence: `api/src/lib/server-context.ts:329-339` (`requireOwner` only); seed policies privilege only `owner`/`member`, never `admin`/`viewer` (`api/src/services/policy.ts:587-661`); `admin` privileged only in `api/src/services/channels.ts:208-212` and `api/src/routes/organizations.ts:13,63`; "roles are string / policy constructs (no Role table exists)" (`api/prisma/schema.prisma:1872-1874`). Absent custom roles: searched `packages/*/src`, `api/src` for a `Role` model / role-CRUD — found nothing.
- Recommendation: Define each role's capability set once as policy rules at seed time (give `admin` an explicit, audited capability set; make `viewer` deny all mutations engine-wide), then introduce a first-class custom-role model bound to policy bindings so customers can author least-privilege roles.

### No read-only auditor/compliance tier; audit log is owner-only and the engine is fail-open in the worker
- Severity: medium
- Effort: M
- Description: A regulated customer's SOC/compliance function needs read-only visibility without administrative power. Here the audit log is gated strictly to `owner` (`requireOwner`) — the same principal that can mutate everything. There is no separate "auditor" or read-only-security role, so compliance review requires handing out full org-owner. Separately, the worker's policy evaluator is fail-open: with no matching rule it returns `{ allowed: true, policySource: 'none' }`. It is currently backstopped by the deny-by-default tool-grant gate, so it isn't directly exploitable today — but it means an org's *policy-defined* deny/approval/time-window rules silently do nothing for any tool/action the grant matrix already allows, and any future caller that relies on this evaluator alone inherits an allow-by-default posture. That divergence from the API engine's deny-by-default (`NO_MATCHING_ALLOW`) is a latent trap.
- Evidence: `api/src/routes/audit-log.ts:17,42,61` (all `requireOwner`); no auditor role: searched `api/src` for a read-only audit role — found nothing. Worker fail-open: `worker/src/run/execute/policy.ts:214` (`return { allowed: true, policySource: 'none' }`) vs API deny-by-default `api/src/services/policy.ts:167-171`.
- Recommendation: Add a read-only auditor capability (a policy rule granting `audit-log:view` to a configurable role, enforced via the engine) and align the worker evaluator to deny-by-default for any path where it is the authoritative gate.

### No separation-of-duties or dual control on privilege grants; single owner is omnipotent and unconstrained
- Severity: medium
- Effort: L
- Description: A single `owner` can unilaterally promote any user (including to `owner`) via `PATCH /api/users/:userId`, with no second-approver, no break-glass, and no cooling-off. Approvals support SoD (`requiredApproverRole`, no self-approval), but that primitive is not applied to the highest-risk action of all — role/ownership escalation — nor to policy-rule changes. There is also no field-level permission model anywhere (e.g. restricting who can edit a task's `assignee` vs its `title`); permissions are whole-resource/whole-action. For finance/health/gov procurement this fails the "no single person can grant themselves power without a witness" control.
- Evidence: `api/src/routes/users.ts:88-121` (owner-only, sets any role, no second approver); SoD exists only in `api/src/services/approvals.ts:140-159` and is not wired into user-role or policy changes; field-level perms: searched `api/src`, `packages/*/src` for per-field authorization — found nothing (all checks are resource+action granularity).
- Recommendation: Route ownership/role grants and policy changes through the approvals SoD path (require a second owner/`requiredApproverRole`), and add an optional dual-control flag for the most sensitive actions.

## Top Priorities
- Unify enforcement on the policy engine as a fail-closed route-level chokepoint and add a CI lint that fails any mutating route lacking an `authorize()` call — closing the "engine exists but 43/47 routes bypass it" gap.
- Fix the cross-tenant policy-binding IDOR immediately (org-scope the rule/binding lookups in `api/src/routes/policy.ts` + `services/policy.ts`) and add gating on project/team membership for tasks and other currently org-flat resources.
- Make the four roles mean one consistent, engine-defined thing (give `admin` an explicit audited capability set, make `viewer` deny mutations everywhere) and introduce a first-class custom-role model for least-privilege.
- Add a read-only auditor/compliance tier and wire separation-of-duties/dual control onto role-grant and policy-change actions; align the worker evaluator to deny-by-default.

## Multi-tenant data isolation & tenant lifecycle

*Persona: Data Protection Officer (leak surface)*

## Maturity
partial

## Current State
- **Tenancy is modelled in the schema:** `organization_id` columns exist on the major child tables (e.g. `Channel`, `Project`, `Task`, `Favorite`, `UserStatus`, `RealtimeEvent`, `InferenceProvider`, `Attachment`) with `Organization` FKs declared `onDelete: Cascade` (`api/prisma/schema.prisma:680-830`, `1098-1199`, `893-904`). DB-level cascade gives a baseline that deleting an `Organization` row would remove most children.
- **The org claim is server-derived, not client-supplied:** at login the session's `org` is resolved from the user's own `organizationMembers` in the DB (`api/src/lib/server-context.ts:467-495`, `auth.ts:427-428`), so a caller cannot mint a token for an arbitrary org. Sessions are single-org (no org-switch endpoint — confirmed absent).
- **Per-request membership re-check (deactivation only):** `authenticateRequest` re-reads `organizationMember` for `(claims.org, claims.sub)` on every request and rejects if `deactivatedAt` is set (`api/src/lib/server-context.ts:293-305`).
- **Real tenant scoping in the hot paths, hand-written:** routes/services consistently pass `actorContext.tenant.organizationId` into queries — search resolves an org-scoped `channelIds` set before the raw FTS query (`api/src/services/messages.ts:536-571`), audit log and ledger scope by org (`routes/audit-log.ts:21,49,64`), file ops check `attachment.organizationId !== organizationId` before streaming/deleting (`packages/runtime/src/files/index.ts:225-260`).
- **Realtime fan-out is org- and channel-scoped:** the SSE hub carries `organizationId` per connection and gates events behind `canAccessChannel` (`api/src/realtime/hub.ts:31,65,81,149-156`), reducing cross-tenant event bleed.
- **Storage is namespaced per org:** object keys are prefixed `${organizationId}/${uuid}` in a shared bucket (`packages/runtime/src/files/index.ts:161`).
- **Secrets encrypted at rest:** MCP/push secrets use AES-256-GCM (`packages/runtime/src/secret-crypto.ts:33-52`).
- **Some targeted cross-org regression tests exist:** `tool-dispatch.test.ts:60`, `tool-grants.test.ts:98,150`, `agent-avatar.test.ts` assert a foreign-org id is rejected.

## Gaps

### Tenant isolation is enforced by developer discipline, not by construction — no Prisma middleware, no Postgres RLS
- Severity: critical
- Effort: XL
- Description: This is my single biggest objection as DPO. There is one shared `PrismaClient` singleton with **no** `$use` middleware and **no** `$extends` query-scoping (`packages/db/src/index.ts:27-40`; grep for `$use`/`$extends` across `api/`, `worker/`, `packages/` returns nothing). There is **no Postgres row-level security** anywhere (no `current_setting`, `set_config`, `SET LOCAL`, `ENABLE ROW LEVEL SECURITY` in code, migrations, or docs). Isolation rests entirely on ~998 hand-written `organizationId` references in `api/src` plus ~198 in `worker/src`, each a clause a developer must remember to add. The canonical danger pattern is `openStream`: `prisma.attachment.findUnique({ where: { id } })` fetches the row across all tenants by global UUID, and the *only* thing stopping a cross-tenant read is the next line `if (attachment.organizationId !== organizationId) return null` (`packages/runtime/src/files/index.ts:225-229`). One forgotten check like that is a reportable GDPR breach. A regulated-industry security review will not accept "we always remember the WHERE clause" — they require isolation enforced at a layer the application cannot bypass.
- Evidence: `packages/db/src/index.ts:27-40`; `packages/runtime/src/files/index.ts:225-229,243-244`; absent: searched `$use|$extends|defineExtension` and `RLS|row level security|current_setting|set_config|SET LOCAL` across `api/ worker/ packages/ docs/` migrations, found nothing.
- Recommendation: Introduce a defence-in-depth boundary the code cannot forget: either Postgres RLS with a per-request `SET LOCAL app.current_org` set inside a transaction wrapper, or a Prisma `$extends` query-extension that injects `organizationId` into every `where`/`create` for tenant-scoped models and refuses tenant-scoped models that lack it. Pair it with a CI lint that fails any tenant-scoped `findUnique`/`findFirst` that doesn't re-assert org. Add a systematic cross-tenant test matrix (every list/read/update/delete route probed with a foreign-org id), not the current handful of spot checks.

### No tenant offboarding: no per-org data export and no hard-delete / erasure path
- Severity: critical
- Effort: L
- Description: When a customer leaves I must *provably* export everything that is theirs and then *provably* erase it — that is the core of GDPR Art. 17/20 and every enterprise DPA. Nessie has neither. There is **no** organization-delete endpoint (the organizations route exposes only `GET`/`PATCH /api/organizations/current` and a public logo getter — `api/src/routes/organizations.ts:24,52,127`), **no** data-export/DSAR endpoint, and **no** anonymization/retention-enforcement code (grep for `export|gdpr|erasure|dsar|offboard|anonymi|deleteOrganization` returns only per-resource deletes of bundles/attachments/policy rules and doc-level "Phase 5 / Phase 3 TODO" notes). The schema's `onDelete: Cascade` would in principle cascade an org delete, but there is no audited, transactional, verifiable workflow that invokes it, nothing to also purge the org's object-storage prefix and `mcp_oauth_secret` rows, and the audit-trail spec explicitly says retention/export is deferred (`docs/audit-trail-spec.md:324-328`). I cannot sign a DPA against this.
- Evidence: `api/src/routes/organizations.ts:24,52,127`; `docs/audit-trail-spec.md:324-328,353`; absent: searched `data export|gdpr|erasure|dsar|offboard|hard.?delete|anonymi|deleteOrganization|retention` across `api/ worker/ packages/runtime docs`, found only per-resource deletes and deferral notes.
- Recommendation: Build a tenant-lifecycle service: (a) full per-org export (DB rows for all `organization_id`-scoped tables + the `${orgId}/` storage prefix + secrets manifest) to a signed archive; (b) a transactional hard-delete that cascades DB rows, deletes the storage prefix, and revokes/erases the org's secrets, all written to an immutable audit record. Document the retention and erasure contract in `docs/`.

### Single instance-wide encryption key for all tenants; no per-tenant keys / BYOK; KMS store still a throwing placeholder
- Severity: high
- Effort: L
- Description: All tenant secrets are encrypted with one key derived by `sha256(NESSIE_AUTH_SECRET)` for the whole deployment (`packages/runtime/src/secret-crypto.ts:23-31`) — there is no per-tenant key separation, so a single key compromise exposes every tenant's MCP/inference/push credentials, and no tenant can hold or rotate its own key (BYOK/CMK is absent — grep finds nothing). Worse, the production MCP secret store is still a placeholder that *throws* "until the KMS secret store lands," with multiple `TODO(phase3)` markers (`api/src/services/secret-resolver.ts:9,33-35`; `api/src/services/mcp-oauth.ts:314-326`; `api/src/routes/mcp.ts:36-52`). Regulated finance/health buyers routinely require CMK/BYOK and key isolation per tenant; deriving every tenant's DEK from the same auth secret also dangerously couples session-signing and data-at-rest key material.
- Evidence: `packages/runtime/src/secret-crypto.ts:23-31`; `api/src/services/secret-resolver.ts:9,33-35`; `api/src/services/mcp-oauth.ts:314-326`; absent: searched `byok|kms|cmk|per-tenant key|envelope` — only TODO/placeholder references found.
- Recommendation: Move to envelope encryption with a per-org data-encryption key wrapped by a KMS-held key (and an optional customer-supplied CMK for BYOK tenants). Separate the data-at-rest key from `NESSIE_AUTH_SECRET`. Land the real KMS-backed `SecretStore` so production isn't running on throwing placeholders.

### Org-scoped `owner` role is trusted from the JWT claim; absent membership "passes through"
- Severity: high
- Effort: M
- Description: Two coupled weaknesses in the trust anchor. (1) `requireOwner` authorises purely off `actorContext.actor.roles` decoded from the token (`api/src/lib/server-context.ts:329-339`) — the comment on `requireSuperAdmin` even admits the session roles are not re-verified against the DB, and only super-admin gets a DB re-check (`:345-365`). A user demoted from owner keeps owner power until their (long-lived) access token expires. (2) The per-request membership check only blocks when a membership row *exists and is deactivated*; an **absent** membership "passes through" by design (`:289-305`). The intent is to let system actors pass, but it means the only thing tying a human session to its org is the original login-time derivation — there is no per-request "does this user still belong to this org" gate. For a DPO, "access continues after the membership is gone, bounded only by token TTL" is exactly the lingering-access exposure auditors flag.
- Evidence: `api/src/lib/server-context.ts:289-305,329-339,345-365`.
- Recommendation: Re-resolve owner/admin authority against `organization_members` per request (as `requireSuperAdmin` already does), or keep token TTL very short with mandatory refresh-time re-validation. Make the membership gate fail-closed for human actors (require a present, non-deactivated membership) and carve out system/service actors explicitly rather than via an open default.

### Shared global job queue with tenant identity buried in JSON payload; no per-tenant fairness/quotas (noisy neighbour)
- Severity: medium
- Effort: M
- Description: `QueueJob` is a single global table with no `organization_id` column — tenancy lives only inside the opaque `payload` JSON, and the worker recovers org context only *after* dequeue from the loaded run/channel (`api/prisma/schema.prisma:1997-2019`; `worker/src/run/execute/run-job.ts:90,130`). That means: (a) there's no way to query, export, or purge "all queued work for org X" during offboarding; (b) there is no per-tenant rate-limiting or fairness on the worker — one tenant can flood the shared queue and starve others (agentic-loop caps are per-run, not per-tenant). The API rate-limiter is also a per-process in-memory `Map` keyed by client, not per-org and not shared across instances (`api/src/lib/server-context.ts:520-565`), so it gives no cross-tenant resource guarantee at scale.
- Evidence: `api/prisma/schema.prisma:1997-2019`; `worker/src/queue.ts`; `worker/src/run/execute/run-job.ts:90,130`; `api/src/lib/server-context.ts:520-565`.
- Recommendation: Add `organization_id` as a first-class column on `queue_jobs` (and a tenant tag on poll/claim) so work is queryable/purgeable per tenant and the poller can enforce per-tenant fairness/quotas. Move rate-limit/quota accounting to a shared, org-keyed store.

### Tenant-isolation guarantee is undocumented and untested at the system level
- Severity: medium
- Effort: M
- Description: For procurement I need a written, testable isolation model: what is the boundary, how is it enforced, what's the blast radius of a bug. `docs/architecture.md` says essentially nothing about tenant isolation (one incidental "tenant" hit, about MCP URLs). Existing cross-org tests are a few targeted unit checks (tool-dispatch, tool-grants, agent-avatar), not a systematic per-route/per-model isolation suite. With isolation enforced only by per-query discipline (gap #1), the absence of both a documented contract and broad negative-path testing means regressions are invisible until they leak.
- Evidence: `docs/architecture.md` (no isolation section — grep `tenant|isolation|RLS|organization_id` returns one incidental line); cross-org tests limited to `api/test/tool-dispatch.test.ts:60`, `tool-grants.test.ts:98,150`, `agent-avatar.test.ts`.
- Recommendation: Write a tenant-isolation spec in `docs/` (boundary definition, enforcement mechanism, threat model) and add a generated cross-tenant test matrix that, for every tenant-scoped route, asserts a foreign-org actor gets 403/404 — wired into CI as a release gate.

## Top Priorities
- **Make isolation structural, not discretionary:** add Postgres RLS or a Prisma `$extends` org-scoping layer plus a CI lint, so a forgotten `organizationId` clause cannot leak data (gap #1) — the prerequisite for any regulated deal.
- **Build the tenant-lifecycle path:** verifiable per-org data export and an audited, transactional hard-delete that also purges the storage prefix and secrets (gap #2) — without this no DPA/GDPR sign-off is possible.
- **Fix the secret-encryption model:** per-tenant envelope keys / BYOK over KMS, decoupled from `NESSIE_AUTH_SECRET`, and replace the throwing KMS placeholders (gap #3).
- **Close the lingering-authority gap:** re-validate owner/admin and org membership per request for human actors instead of trusting JWT roles and an open "absent membership passes" default (gap #4).

## Scalability & performance at enterprise scale

*Persona: Principal scale engineer (p99/contention)*

## Maturity
early

## Current State
- **Postgres-backed work queue with correct concurrency primitives.** `claimNextJob` uses `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` with a partial poll index, lock TTL + background lock renewal, idempotency-key dedupe, and attempt/dead-letter handling (`packages/runtime/src/queue.ts:228-256`, `:196-226`; index doc at `api/prisma/schema.prisma:2013-2018`). This is the right pattern for multi-consumer safety.
- **Worker is genuinely multi-instance-safe for scheduled work.** Trigger scheduler and mailbox dispatch both claim rows with `FOR UPDATE SKIP LOCKED` + lease/claim timestamps (`worker/src/control/trigger-scheduler.ts:45-55`, `worker/src/control/mailbox.ts:89-117`, reclaim at `:155-175`), so you can run N workers without double-execution.
- **Realtime fan-out across instances via Postgres `LISTEN/NOTIFY`.** Publishers `pg_notify('nessie_realtime', …)`; every API process holds a dedicated listener client and re-broadcasts to its own connections (`packages/runtime/src/realtime.ts:57-63, 172-225, 227-277`). This means cross-instance delivery does work without Redis.
- **Message listing uses keyset (cursor) pagination with a hard cap.** `DEFAULT_MESSAGE_PAGE_SIZE = 50`, `MAX_MESSAGE_PAGE_SIZE = 200`, `take: limit + 1`, keyset on `(createdAt, id)` (`api/src/services/messages.ts:159-160, 190, 231-245`). API list query schema caps `limit` at 200 (`packages/schemas/src/api.ts:33`). No unbounded `findMany` on the hot message path.
- **Schema is broadly indexed** — 238 `@@index`/`@@unique` declarations, including composite tenant-scoped and `(sort: Desc)` cursor indexes and replay indexes `idx_thread_stream_events_replay`/`idx_realtime_events_replay` (`api/prisma/schema.prisma:889, 901`, plus a dedicated `20260414000000_add_performance_indexes` migration).
- **`realtime_events` has time-based retention** — 24h cutoff pruned every 60s, backed by `@@index([organizationId, createdAt])` (`api/src/services/realtime-events.ts:6-7, 148-160`; index at `schema.prisma:902`).
- **Streaming uploads with quota accounting** — multipart ceiling = configured max upload (5 GiB) and per-route re-limits; FileService is the single chokepoint (`api/src/index.ts:221-223`).

## Gaps

### Realtime fan-out is O(connections × events) with an uncached DB query per connection per event
- Severity: critical
- Effort: L
- Description: This is the first thing that falls over at 10k users. Inside the hub's notification handler, every inbound event iterates **all** in-process WS and user-SSE connections, and for each one calls `canAccessChannelEvent` → `getVisibleChannel`, which is a fresh, **uncached** `prisma.channel.findUnique` with a `members` sub-select (`api/src/realtime/hub.ts:140-194`; `api/src/lib/request-helpers.ts:443-448`; `getVisibleChannel` body is a raw `findUnique`, no cache). A single message in a 500-member channel = 500 connection iterations × a DB roundtrip each = 500 authorization queries for one event. Multiply by message rate across thousands of channels and the database is doing tens of thousands of point-lookups per second purely to decide who may see an event it already fanned out. p99 on the SSE/WS path will collapse, and the per-event DB load competes with the same Postgres serving the queue and the app. There is no per-connection membership cache, no scope short-circuit beyond an exact scope-key match, and a `TODO` at `realtime-events.ts:100` admits membership is only recomputed on reconnect anyway — so the per-event recheck is paying full DB cost for data that is effectively static for the connection's lifetime.
- Evidence: `api/src/realtime/hub.ts:140-194`; `api/src/lib/request-helpers.ts:443-448` and the `getVisibleChannel` definition above it; `api/src/services/realtime-events.ts:100`. Caching: absent — searched `lru-cache|node-cache|memoize|TTLCache` across `api/src` and `packages/*/src`, found nothing.
- Recommendation: Cache channel visibility per `(userId, channelId)` in-process with a short TTL and invalidate on membership-change events; precompute the connection's authorized channel set at connect time and gate purely on the in-memory set (it already stores `channelIds`), only re-querying on an explicit membership-change signal. Index the fan-out by channel (`Map<channelId, Set<connection>>`) instead of scanning every connection for every event.

### No connection pooler; each API process opens ~3 pools and prod runs a single un-replicated instance
- Severity: critical
- Effort: M
- Description: Default `poolMax = 10` (`packages/config/src/index.ts:74-75, 198-199`), and a single API process instantiates **three** independent pg pools — the Prisma client (`api/src/lib/server-context.ts:166`), the realtime hub pool (`api/src/realtime/hub.ts:102`), and the memory pool (`api/src/index.ts:186`) — plus a dedicated `LISTEN` client. That is ~30+ backend connections per API instance before the worker's pools. Postgres default `max_connections` is 100; there is **no PgBouncer and no `max_connections` tuning** in the production Compose (searched `infrastructure/compose/docker-compose.prod.yml`, found neither). So you can stand up maybe 2-3 API replicas before the database refuses connections — which is the only horizontal-scaling lever you have, since the realtime hub holds connection state in process-local `Set`s and SSE/WS are inherently sticky. Worse, production is currently a **single fixed container** (`container_name: nessie-api`, no `deploy.replicas`), so there is no horizontal scaling configured at all and no story for it. A regulated enterprise SRE team will ask "how do I run this active-active across 3 AZs" and the answer today is "you can't without a pooler and replica wiring."
- Evidence: `packages/config/src/index.ts:74-75`; pool creation at `api/src/lib/server-context.ts:166`, `api/src/realtime/hub.ts:102`, `api/src/index.ts:186`; single-container prod with no replicas in `infrastructure/compose/docker-compose.prod.yml` (`container_name: nessie-api`, no `deploy:` block); PgBouncer/`max_connections`: absent.
- Recommendation: Front Postgres with PgBouncer (transaction pooling) and point all pools at it; collapse the three pools toward one shared pool where possible; raise/tune `max_connections`; add `deploy.replicas` guidance and document the per-instance connection budget. This is a prerequisite for any multi-instance deployment.

### Unbounded high-churn tables: `thread_stream_events` and completed `queue_jobs` are never pruned
- Severity: high
- Effort: M
- Description: Streaming writes one `thread_stream_events` row per `stream.start/reasoning/delta` chunk — i.e. token-by-token during agent output — yet there is **no retention or pruning** for this table anywhere (searched `thread_stream_events`/`threadStreamEvent` for delete/prune/retention across `api/src`, `worker/src`, `packages/*/src` — nothing), and it has **no `createdAt` index**, only `(thread_id, id)` (`api/prisma/schema.prisma:881-891`). Similarly, `queue_jobs` rows are only ever `UPDATE`d to `status='done'`/`'dead'` — never deleted (`packages/runtime/src/queue.ts:112-141`). Both tables grow without bound. At enterprise message volume `thread_stream_events` becomes the largest table in the database within weeks; bloat degrades the queue poll index, the replay reads, and autovacuum. The one table that *is* pruned (`realtime_events`) prunes with `deleteMany WHERE createdAt < cutoff` but the pruning predicate is `createdAt`-only — fine because it has `(organizationId, createdAt)`, but the per-instance 60s `deleteMany` of a day's churn is itself a large delete with no batching (`api/src/services/realtime-events.ts:148-160`).
- Evidence: `api/prisma/schema.prisma:881-891` (no `createdAt` index, no retention); `packages/runtime/src/queue.ts:112-141` (done/dead never deleted); pruning search returned only `realtime-events.ts`; `api/src/services/realtime-events.ts:148-160`.
- Recommendation: Add a retention sweep (batched `DELETE` or, better, time-based partitioning / `pg_partman`) for `thread_stream_events` and terminal `queue_jobs`; add a `createdAt` index where retention queries it; batch the `realtime_events` prune. Partitioning these append-only tables by day is the scalable answer.

### Rate limiting is in-memory per process — ineffective across instances and trivially bypassed at scale
- Severity: high
- Effort: M
- Description: The limiter is a process-local `Map<string, RateLimitBucket>` (`api/src/lib/server-context.ts:520-565`). The moment you run more than one API instance (which the connection-pool gap says you must, to scale), the effective limit multiplies by the replica count and load-balancer fan-out makes it non-deterministic — an attacker spreading requests across instances gets N× the budget. Coverage is also thin: only auth, message-post, and agent-mutation routes have rules (`:526-538`); every other endpoint, including expensive search/list/ledger reads, is unthrottled. For a regulated buyer this fails both the abuse-prevention and the DoS-resilience line items of a security review.
- Evidence: `api/src/lib/server-context.ts:520-565`; rule coverage at `:526-538`.
- Recommendation: Move rate-limit state to a shared store (Postgres token-bucket or, if Redis is ever added, Redis); apply a global default budget per principal/IP plus per-route overrides; enforce at the edge (Caddy) as a coarse second layer.

### Single Postgres doing quadruple duty (OLTP + queue + pub/sub + pgvector) with no read replica
- Severity: high
- Effort: L
- Description: One Postgres instance carries the transactional app, the polling queue (`queue_jobs`), the realtime bus (`pg_notify` + `thread_stream_events`/`realtime_events` replay reads), and pgvector similarity search. There is **no read-replica support** anywhere (searched `readReplica|replicaUrl|REPLICA_URL|primary.*replica` across config/api/db — nothing). Every list/search/ledger/audit read, every queue poll (one loop per topic, 1s interval — `packages/runtime/src/queue.ts:41, 148`), and every per-event authorization query all hit the same primary. At 10k users the queue pollers + realtime auth queries alone create a steady contention floor before a single user-facing read. Heavy reads (audit log, ledger rollups, KB semantic search) cannot be offloaded. `pg_notify` also has a hard 8000-byte payload limit, and large WS/SSE payloads are serialized straight into it (`packages/runtime/src/realtime.ts:62, 270`) with no size guard — a large event will throw at notify time.
- Evidence: read replicas: absent (searched config/api/db); queue poll loop `packages/runtime/src/queue.ts:41, 148`; `pg_notify` payload at `packages/runtime/src/realtime.ts:62, 270` with no length check.
- Recommendation: Add a read-replica DATABASE_URL and route read-only queries (lists, search, audit, ledger) to it via a separate Prisma client; guard `pg_notify` payloads against the 8KB limit (publish a row id and have listeners fetch, rather than inlining payloads); consider moving the queue to `LISTEN/NOTIFY`-driven wakeups instead of fixed 1s polling per topic to cut idle DB load.

### No load, soak, or capacity testing — and no documented scale target
- Severity: high
- Effort: L
- Description: There is no load/perf harness in the repo — searched for k6/artillery/locust/stress/load-test, found nothing functional; `simulation/` is persona-driven functional probing (`simulation/probe-*.ts`, `personas.json`), not concurrency or throughput testing. The deployment doc contains no replica/HA/throughput/concurrency guidance whatsoever (searched `docs/deployment.md` for `replica|scale|HA|concurrent|throughput|sticky|load balanc` — only incidental hits). For a buyer sizing thousands to tens of thousands of users, "we have never measured where it breaks" is disqualifying in a procurement/architecture review. You cannot make a capacity commitment, an SLA, or a sizing recommendation without it.
- Evidence: load tooling: absent (searched k6/artillery/locust/stress); `simulation/` contents are functional probes; scale guidance: absent in `docs/deployment.md`.
- Recommendation: Build a load harness (k6) for the three hot paths — message post + SSE fan-out, queue throughput, and concurrent list reads — establish a documented capacity envelope and p99 budgets, and publish sizing/replica guidance. Wire it into CI as a regression gate.

## Top Priorities
- **Fix the realtime fan-out hot path first** (critical): per-connection in-memory authorization with membership-change invalidation, and channel-indexed delivery instead of full-connection scans. This is the single biggest p99 risk and it directly couples user-facing latency to database load.
- **Introduce a connection pooler (PgBouncer) and a real horizontal-scaling story** (critical): consolidate the three per-process pools, tune `max_connections`, and document/configure API `deploy.replicas` — nothing else scales until the connection budget is solved.
- **Add retention/partitioning for `thread_stream_events` and terminal `queue_jobs`, and a read replica for heavy reads** (high): stop the unbounded-table time bomb and take read load off the contended primary.
- **Build a k6 load/soak harness and publish a measured capacity envelope** (high): you cannot sell or size an enterprise deployment on an unmeasured system; make breakage points and p99 budgets a CI gate.

## Reliability, disaster recovery & observability

*Persona: SRE VP (3am pager, MTTR)*

## Maturity
partial

## Current State
- Postgres-backed job queue with correct visibility-timeout semantics: `FOR UPDATE SKIP LOCKED` claim, `locked_until` lease, lock renewal at 1/3 TTL for long runs, stuck-job reclaim, per-job `attempt`/`max_attempts`, dead-lettering, and idempotency keys (`packages/runtime/src/queue.ts:126-256`). This is the strongest reliability asset in the codebase.
- Real readiness probe (not just liveness): `GET /api/health/ready` returns 503 when the DB is unreachable or the worker has stopped heartbeating; `GET /api/health` is a flat liveness 200 (`api/src/routes/health.ts:11-25`, `api/src/services/ops-health.ts:137-155`).
- Worker liveness is derived from heartbeat recency (90s = 3 missed beats → up/stale/down) rather than provider status, with the reasoning documented inline (`api/src/services/ops-health.ts:14-55`).
- Container healthchecks wired for every prod service (postgres `pg_isready`, minio `mc ready`, api `/api/health`, admin `/healthz`, gateway `/health`) with `depends_on: service_healthy` gating (`infrastructure/compose/docker-compose.prod.yml:31-198`).
- Structured JSON logging via Fastify's built-in pino logger, with the WS `token` query param redacted from access logs (`api/src/index.ts:114-124`).
- Graceful shutdown: API `onClose` hooks and worker `SIGINT`/`SIGTERM` handlers that abort the queue loop, clear intervals, and drain pools/Prisma; deliberate handling of the embedded-vs-standalone worker so the worker doesn't hijack the API's signals (`worker/src/index.ts:58-65,311-331`; `api/src/index.ts:250,377-398`).
- Trigger-delivery retry with exponential backoff capped at a max (`packages/runtime/src/scheduling.ts:196-213`).
- Migrations applied via `prisma migrate deploy` with a documented self-repair for one specific interrupted migration, gated behind a `pg_isready` wait so migrations don't run against a Postgres still in WAL recovery (`infrastructure/compose/redeploy.sh:31-55`).
- An ops-health surface for owners (queue counts, dead jobs, dead-letter mailbox) with error-text capping to avoid cross-tenant payload leakage (`api/src/services/ops-health.ts:83-135`).
- A disk-exhaustion incident is documented with mitigations and a safe manual reclaim procedure — the seed of a runbook (`docs/deployment.md:176-191`).

## Gaps

### No automated backups and no tested restore — the entire customer dataset is one volume away from permanent loss
- Severity: critical
- Effort: M
- Description: I will be asked, in the procurement security questionnaire, "what is your RPO and when did you last test a restore?" Today the honest answer is: there is no backup. Production is a single `nessie_pgdata` Docker volume and a single `nessie_miniodata` volume on one Hetzner box, with no `pg_dump`, no WAL archiving, no snapshot cron, no off-host copy, and no documented restore drill. If that disk corrupts, the host is reimaged, or a bad migration mangles data, every organisation's channels, tasks, audit trail, and token ledger are gone with no recovery path. The deployment doc itself records that this exact disk filled to 100% and crashed Postgres into WAL recovery on 2026-06-10 — proof the failure mode is live, not theoretical. The only `backup_configuration` in the repo is in the retired GCP terraform, which doesn't run.
- Evidence: `infrastructure/compose/docker-compose.prod.yml:201-203` (two plain named volumes, no backup sidecar); `grep -rni backup docs/deployment.md` → nothing; the only `backup_configuration`/`retained_backups` hits are in `infrastructure/terraform/modules/cloud-sql/main.tf:46-53` (retired GCP, not deployed); `redeploy.sh` never dumps before migrating. The deployment doc only says "back it up alongside `nessie_pgdata`" (`docs/deployment.md:283`) — an instruction to a backup process that does not exist.
- Recommendation: Add a `pg_dump` (or `pgbackrest`/WAL-G) cron sidecar writing encrypted dumps to off-host object storage with daily + PITR retention; back up `nessie_miniodata` the same way; write and execute a restore runbook and record the measured restore time. Until a restore has been performed end-to-end, treat the backup as non-existent.

### No DR plan and no stated RTO/RPO — single host, single Postgres, no failover
- Severity: critical
- Effort: L
- Description: Everything runs on one Hetzner box: one API, one worker, one Postgres, one MinIO, all `restart: unless-stopped` with no replicas. When that node dies at 3am — kernel panic, disk failure, Hetzner maintenance — the entire platform is down for every tenant until I rebuild a host by hand from a tree that has no backup to restore. There is no Postgres replica/standby, no multi-AZ, no documented failover, and nowhere in the repo states an RTO or RPO. For a regulated buyer (finance/health/gov) this fails the BCP/DR section of the security review outright; they require committed RTO/RPO and evidence of a DR exercise.
- Evidence: `infrastructure/compose/docker-compose.prod.yml` — every service is single-instance, no `deploy.replicas`, no standby; `grep -rni "replica|standby|streaming|patroni|failover|RTO|RPO"` across `infrastructure`/`docs` → only the retired GCP terraform; `docs/deployment.md` describes "a single Hetzner host" (`:7-9`) with no DR section.
- Recommendation: State target RTO/RPO explicitly. At minimum stand up a streaming-replica Postgres on a second host with documented promotion, move object storage to a replicated/backed bucket, and write a host-loss runbook. For enterprise tiers, offer an HA topology (managed Postgres or Patroni + load-balanced API/worker).

### Deploys are build-on-host with no health gate, no rollback, and a guaranteed outage window
- Severity: high
- Effort: M
- Description: Every push to `main` SSHes to the single prod host and runs `docker compose build` + `up -d` in place. There is no image registry, no staging, no blue/green or rolling step, no post-deploy health check, and no automatic rollback. `docker compose up -d` recreates the single API/worker/admin containers, so there is a downtime window on every deploy, and the worker even `depends_on api` so the order amplifies it. If a build or migration ships broken, the workflow reports success regardless — `redeploy.sh` never curls `/api/health` after recreate — and the only "rollback" is a human reverting and re-deploying. This is not zero-downtime and it is not safe for a platform thousands of users depend on.
- Evidence: `.github/workflows/deploy.yml` (rsync + `bash redeploy.sh` over SSH, no health verification, no registry); `infrastructure/compose/redeploy.sh:57-58` (`$COMPOSE up -d` recreate, then it just prints status — `grep -i "health|curl|rollback|verify" redeploy.sh` → nothing); `docker-compose.prod.yml:151-157` (`worker depends_on api: service_started`).
- Recommendation: Build images in CI, push to a registry, deploy by tag, and gate promotion on a post-deploy `/api/health/ready` curl with automatic rollback to the previous tag on failure. Run >1 API replica behind Caddy so a rolling recreate doesn't drop all traffic. The readiness probe already exists — wire the deploy to actually use it.

### No metrics, no tracing, no alerting — "we have logs" is the entire observability story
- Severity: high
- Effort: L
- Description: When I'm paged at 3am I need to answer "what's the p99 latency, the error rate, the queue depth, the saturation" in seconds — from a dashboard, not by tailing JSON logs across containers. There is no Prometheus endpoint, no `prom-client`, no OpenTelemetry/distributed tracing, and no metric for request latency, error rate, queue depth, DB pool saturation, or LLM cost rate. There is also no alerting anywhere: nothing pages a human when the worker stops heartbeating, when dead-letters pile up, when the disk fills, or when a deploy fails — the deploy workflow has no failure notification. The ops-health data exists in the DB but is only reachable by an owner hitting an authed endpoint; nothing scrapes or alerts on it. Logs ship to Docker's default driver with no aggregation, no retention policy, and no rotation config, and request IDs are not propagated across the queue into the worker, so a single agent run can't be traced end-to-end.
- Evidence: `grep -rn "prom-client|prometheus|/metrics|opentelemetry|@opentelemetry"` across `api`/`worker`/`packages` → nothing; `grep -rni "alert|pagerduty|opsgenie|notify.*fail"` across `infrastructure`/`.github/workflows` → nothing; no logging driver/rotation config in `docker-compose.prod.yml`; `requestId`/`correlationId` exist only as inference-control-plane domain fields (`api/src/contracts/inference-core.ts:239-308`), not as cross-service log correlation; the disk-fill incident (`docs/deployment.md:176-191`) was caught by a crash, not an alert.
- Recommendation: Expose a `/metrics` Prometheus endpoint (latency, error rate, queue depth/age, pool usage, ledger spend rate) on API and worker; add OpenTelemetry tracing with a request/run ID propagated through the queue payload into the worker; scrape with Prometheus + Grafana; and define alert rules (worker down, dead-letter growth, disk >80%, readiness failing, deploy failure → page).

### No SLOs and no runbooks — recovery depends on tribal knowledge
- Severity: medium
- Effort: M
- Description: There are no defined SLOs/SLIs (availability, latency, queue-processing-time targets) and no error budget, so there's no objective signal for "is the service healthy" or "should we stop shipping." There is also no runbook library: no documented procedure for restoring from backup, promoting a replica, draining/replaying the dead-letter queue, recovering a stuck migration beyond the one hard-coded case, or responding to disk exhaustion beyond a paragraph in the deployment doc. MTTR at 3am is whatever the on-call engineer can reverse-engineer from the queue SQL and compose file. A regulated buyer expects an operations manual.
- Evidence: `grep -rni "SLO|SLA|runbook|on-call|MTTR"` across `docs` → no operational hits (only unrelated "translation"/"SLA"-shaped substrings); no `docs/runbooks/` or `docs/operations.md`; `docs/deployment.md` covers first-deploy/redeploy but has no restore, failover, or incident-response sections.
- Recommendation: Define availability/latency/queue SLOs with error budgets, and write runbooks for the top incidents (host loss, restore-from-backup, replica promotion, dead-letter drain, disk full, failed migration). Store them in `docs/runbooks/` and link them from `deployment.md`.

### No container resource limits — one runaway agent run can starve the whole host
- Severity: medium
- Effort: S
- Description: None of the prod containers declare CPU or memory limits, and they share the box with other apps (voicepos, hugo) and the shared Caddy. An agentic run that buffers a 5 GiB upload, a memory leak, or a fork bomb in the worker can consume all host memory/CPU and take down not just Nessie but every co-tenant app — including the shared Postgres that other apps depend on. The host already proved it has no headroom guardrails when build cache silently filled the disk and crashed the database. On a shared host this is a noisy-neighbour outage waiting to happen.
- Evidence: `grep -n "mem_limit|cpus|memory:|deploy:" infrastructure/compose/docker-compose.prod.yml` → only `restart:` lines, no resource constraints; `docs/deployment.md:63-70,176-191` confirms the shared-host topology and a prior resource-exhaustion crash.
- Recommendation: Add `mem_limit`/`cpus` (or `deploy.resources`) to api/worker/postgres/minio so a single container cannot exhaust the shared host, and alert on container OOM kills.

## Top Priorities
- Stand up automated, off-host, encrypted Postgres + MinIO backups and perform a real restore drill — then publish the measured RTO/RPO. Nothing else matters if the data can't be recovered.
- Make deploys safe: build images in CI to a registry, gate promotion on the existing `/api/health/ready` probe, add automatic rollback, and run >1 API replica so recreate isn't a global outage.
- Add real observability: a Prometheus `/metrics` endpoint (latency, error rate, queue depth/age, pool, spend), OpenTelemetry tracing with a run ID propagated across the queue, and alert rules that page a human on worker-down, dead-letter growth, disk >80%, and deploy failure.
- Write a DR/operations runbook set (host loss, restore, replica promotion, dead-letter drain, disk full) and define SLOs, and add per-container resource limits so a runaway run can't take down the shared host.

## Audit trail integrity, data retention, GDPR lifecycle

*Persona: GRC / internal audit lead (SOC2/GDPR)*

## Maturity
early

## Current State
- A single `AuditLog` table exists with tenant scoping, actor (user/agent/service/system), action, resource, outcome, reason, JSON metadata, requestId, IP, and userAgent: `api/prisma/schema.prisma:2097-2124`.
- Audit events are written via a central best-effort helper that redacts a fixed denylist of secret-like field names from metadata before persisting: `api/src/services/audit.ts:4-74`.
- A read-only audit API exists (list with cursor pagination + filters, single-entry get, group-by summary), gated to organization owners only, with no write endpoint: `api/src/routes/audit-log.ts:14-71`, `api/src/services/audit.ts:100-250`.
- Audit emission is wired into a subset of routes: project/team/channel CRUD, KB pages/files/comments, policy CRUD, push credentials, and (via service) approval approve/reject and PA bootstrap: `api/src/routes/projects.ts`, `teams.ts`, `channels.ts`, `knowledge-base.ts`, `knowledge-base-files.ts`, `knowledge-comments.ts`, `policy.ts`, `platform-push.ts`, `api/src/services/approvals.ts:203-206`.
- The worker emits `policy.evaluated` audit events around the agentic loop: `worker/src/run/execute/policy.ts:217-306`, `worker/src/run/execute/agent-loop.ts:254,285`.
- The token-cost ledger (`TokenLedgerEvent`) is deliberately retained through org deletion (no FK cascade) for billing/audit retention: `api/prisma/schema.prisma:2126-2128`.
- Users can be deactivated/reactivated (soft, reversible membership toggle), with last-owner protection: `api/src/routes/users.ts:123-164`.
- A spec documents intended audit coverage and retention as future work (Phase 3+/Phase 5): `docs/audit-trail-spec.md:319-328`.

## Gaps

### Audit trail is not tamper-evident or immutable — it is a plain, mutable, best-effort table
- Severity: critical
- Effort: L
- Description: As the audit lead, this is my first and most disqualifying finding. The audit log is an ordinary Postgres table with a UUID PK and indexes — no hash chain, no per-row HMAC/signature, no sequence number, no prior-row linkage, and no DB-level append-only protection (no `REVOKE UPDATE/DELETE`, no `BEFORE UPDATE/DELETE` trigger or rule). Anyone with DB credentials — a DBA, an SRE, a compromised app role, the self-hosting customer's own admin — can silently `UPDATE` or `DELETE` rows and I cannot prove they didn't. Worse, the application write path swallows every failure (`catch {}` with only a `console.error`), so a write that silently fails leaves no record and no alert — "best-effort" audit is, for SOC 2 / a regulator, no audit. I cannot certify completeness or integrity of any record, which fails the foundational tamper-evidence control.
- Evidence: `api/prisma/schema.prisma:2097-2124` (no integrity columns); `api/prisma/migrations/20260409010000_phase2_models/migration.sql:86-110` (plain table, only PK + indexes, no triggers/REVOKE); `api/src/services/audit.ts:49-73` (`try/catch` swallows failures, never throws); searched `api/prisma/migrations` for `REVOKE|BEFORE UPDATE|BEFORE DELETE|RULE|hash.?chain|prev_hash|merkle|signature|hmac` against audit — found nothing.
- Recommendation: Make the log cryptographically append-only: add `sequenceNumber` + `prevHash` + per-row HMAC (or sign batches into a Merkle root anchored externally/WORM), and at the DB layer run the app under a role with `INSERT, SELECT` only on `audit_logs`, plus a `BEFORE UPDATE OR DELETE` trigger that raises. Treat audit-write failure as a hard error path (dead-letter + alert), not a swallowed log line.

### Coverage of privileged actions is roughly 20% — the highest-value events are not audited
- Severity: critical
- Effort: L
- Description: The `AuditAction` enum *declares* `auth.login`, `auth.logout`, `auth.login_failed`, `auth.bootstrap`, `user.created/updated/deleted/role_changed`, `tool.granted/revoked`, `agent.created/deleted`, `approval.created`, etc. — but the code emits almost none of them. Only 8 of ~45 route files call `emitAuditEvent` at all. `auth.ts`, `users.ts`, `agents.ts`, `mcp.ts`, `approvals.ts` (route), `uploads.ts`, `tasks.ts`, `tools.ts`, `organizations.ts`, `triggers.ts`, `ledger.ts` emit zero. That means I have no record of: logins or failed logins (no brute-force/forensic trail), role/privilege escalations, user provisioning/deprovisioning, MCP connector registration/approval (the exact egress-to-third-party events a regulator cares about), tool-grant changes to agents, file uploads/downloads, or message edits/deletes. The agentic worker only logs `policy.evaluated` — it never records which tool an agent actually invoked, with what arguments, or the result, so I cannot answer "what did the AI do on behalf of this user." For a regulated buyer, "show me every privileged action" is unanswerable today.
- Evidence: `emitAuditEvent` present in only 8 route files (verified `grep` across `api/src/routes`); confirmed 0 emit calls in `auth.ts`, `users.ts`, `agents.ts`, `mcp.ts`, `approvals.ts`, `uploads.ts`, `tasks.ts`, `tools.ts`, `organizations.ts`, `triggers.ts`, `ledger.ts`; message edit/delete handlers `api/src/routes/threads.ts:353,415` have no audit and no `message.edited/deleted` action in the enum (`packages/schemas/src/governance.ts:186-255`); worker emits only `policy.evaluated` (`worker/src/run/execute/policy.ts:217-306`); spec itself defers most coverage to "Phase 3+" (`docs/audit-trail-spec.md:319-320`).
- Recommendation: Define the privileged-action set and enforce coverage at the boundary — emit audit in auth (login/logout/failed/bootstrap), user/role mutations, MCP register/approve/activate/delete, tool grants/revokes, agent lifecycle, approvals creation, uploads/downloads, and message edit/delete. Add the missing enum actions. In the worker, audit each tool invocation (tool, redacted args hash, outcome). Add a CI test asserting every state-mutating route has an audit assertion.

### No GDPR data-subject lifecycle: no right-to-access export and no right-to-erasure
- Severity: critical
- Effort: XL
- Description: For any EU/UK customer (and most regulated buyers globally), I must be able to (a) produce everything held about a data subject on a DSAR, and (b) erase them on request. Neither exists. The only "delete" for a user is a reversible deactivation flag; there is no per-user export, no erasure/anonymization/pseudonymization path, and no "records of processing." A user's PII and authored content (messages, KB pages, attachments, ledger rows, audit entries with IP/userAgent) are spread across many `organization_id`-scoped tables with no subject-centric collation. I cannot satisfy a 30-day DSAR or an erasure request, which is a direct legal-exposure blocker for EU procurement and a guaranteed finding in a privacy review.
- Evidence: User "delete" is deactivation only (`api/src/routes/users.ts:123-164`); searched `api/src worker/src packages` for `gdpr|right.to.eras|erasure|anonymi[sz]|pseudonym|data.subject|dataExport|records.of.processing` — found nothing in code (only the unrelated 24h realtime-event TTL `api/src/services/realtime-events.ts:6` and doc-only mentions); no hard delete (`prisma.user.delete`/`eraseUser`/`anonymizeUser`) anywhere — searched, found nothing; GDPR appears only in docs as aspiration (`docs/openclaw-reference.md:906`).
- Recommendation: Build a data-subject service: an authenticated `GET /api/admin/users/:id/export` that assembles all subject data into a portable bundle, and an erasure workflow that crypto-shreds/anonymizes PII across the known table set while preserving non-PII audit/ledger rows under a documented legal basis. Maintain a records-of-processing register. Both operations must themselves be audited.

### No configurable retention, no legal hold, no eDiscovery
- Severity: high
- Effort: L
- Description: Retention is "indefinite, no purge," hard-coded by absence. There is no per-org retention policy, no scheduled purge/archive, no legal-hold flag that pins records against deletion during litigation, and no eDiscovery export (the audit API returns paginated JSON to a single org owner only — no CSV/bundle, no cross-scope investigator export, no chain-of-custody manifest). A regulated customer needs to say "messages: 7 years, audit: 10 years, purge the rest" and "freeze everything for case X." None of that is expressible. Indefinite retention is also itself a GDPR storage-limitation problem.
- Evidence: `docs/audit-trail-spec.md:322-328` ("retained indefinitely... no automatic purge... Phase 5 will add configurable retention"); no `retention`/`legalHold`/`purge` field on `Organization` (`api/prisma/schema.prisma:646+`, verified); searched code for `legal.?hold|ediscovery|retention.policy` — found nothing; audit API has no export endpoint (`api/src/routes/audit-log.ts` only list/get/summary).
- Recommendation: Add per-org, per-data-class retention policies with a scheduled purge job (export-before-delete), a `legalHold` mechanism that overrides purge at row/scope level, and an eDiscovery export (signed bundle + manifest) reviewable by a designated investigator role.

### No data classification, PII detection, or DLP; redaction is a fixed field-name denylist
- Severity: high
- Effort: L
- Description: There is no data classification model (public/internal/confidential/restricted), no PII detection/tagging, and no DLP controls on what agents or connectors can read or exfiltrate. The only redaction is a hard-coded denylist of 9 key names (`password`, `token`, etc.) applied to audit metadata — it is trivially bypassed by any field not named exactly those keys (e.g. `ssn`, `card`, free-text containing a secret), and it protects only the audit log, not the data plane. Regulated buyers in finance/health/gov require classification-driven handling and DLP egress controls before approving an AI platform that can call external MCP connectors.
- Evidence: Denylist redaction `api/src/services/audit.ts:4-31` (9 literal keys, substring/value content not inspected); searched `api/src worker/src packages` for `dlp|data.loss|data.classif|pii` — found nothing; no classification field on content models.
- Recommendation: Introduce a classification taxonomy on channels/spaces/attachments, a PII detector feeding tags, and DLP egress policy enforced in the agentic loop and MCP dispatch (block/redact restricted data leaving the org boundary). Replace the audit denylist with classification-aware redaction.

### Audit emission is fire-and-forget, decoupled from the mutation transaction
- Severity: medium
- Effort: M
- Description: Audit writes happen outside the business transaction and never roll it back — by design ("Audit emission must never roll back the primary mutation"). This is defensible for availability but means a mutation can succeed while its audit row silently never lands, producing gaps I cannot detect or explain to an examiner. Combined with the swallowed-error path, there is no guarantee of one-audit-per-privileged-action.
- Evidence: `api/src/services/audit.ts:69-73` (comment + swallowed catch); emission called as a separate `await`, not within the mutating `prisma.$transaction`.
- Recommendation: Either write audit in the same transaction as the mutation (transactional outbox) or push failed audit writes to a durable dead-letter with alerting and a reconciliation job, so a missing audit row is detectable and recoverable.

## Top Priorities
- Make the audit log cryptographically tamper-evident and physically append-only (hash chain/HMAC + DB role REVOKE + delete/update-blocking trigger), and stop swallowing audit-write failures — without this, nothing else in the audit story is defensible.
- Close the coverage gap to ~100% of privileged actions: auth/login events, user & role changes, MCP connector and tool-grant changes, approvals, uploads/downloads, message edit/delete, and per-tool agent invocations in the worker — enforced by a CI coverage test.
- Build the GDPR data-subject lifecycle (per-user export + erasure/anonymization with documented legal basis) plus a records-of-processing register; this is a hard legal blocker for EU/regulated procurement.
- Add configurable per-class retention with scheduled purge, a legal-hold override, and a signed eDiscovery export bundle — replacing today's silent "indefinite, no purge" default.

## Cost accounting, budgets, chargeback & metering

*Persona: FinOps lead (hard caps/chargeback)*

## Maturity
partial

## Current State
- Token-cost ledger with per-inference rows and rich attribution (org/project/team/channel/thread/task/run/agent/actor), idempotent on `inference_invocation_id` to prevent double-counting on redelivery: `api/prisma/schema.prisma:2129-2184`, written by `recordInferenceUsage` in `packages/runtime/src/ledger.ts:258-328`.
- Per-org/model pricing profiles with effective-dated rows and a partial-unique active-row constraint; cost computed from input/output/cache token rates: `api/prisma/schema.prisma:2231-2256`, `packages/runtime/src/ledger.ts:171-204`.
- Budget model with `costLimitUsd`, `tokenLimit`, `storageLimitBytes`, modes `off|warn|enforce|degrade|unlimited`, period `weekly|monthly|yearly`, scoped to org/project/team with most-specific-first resolution: `api/prisma/schema.prisma:2186-2229`, `packages/runtime/src/budget.ts:161-231`.
- A worker budget gate that blocks automation runs over cap and can degrade to a cheaper model; live human turns are exempt unless `blockHumansWhenOver`: `worker/src/run/execute/budget-gate.ts:8-69`, invoked at run start in `worker/src/run/execute/run-job.ts:79`.
- Append-only signed-delta storage ledger (`StorageUsageEvent`) and a hard, synchronous storage-quota gate (`checkStorageQuota`) that blocks uploads over `storageLimitBytes`: `api/prisma/schema.prisma:2317-2340`, `packages/runtime/src/budget.ts:378-407`.
- Separate per-call connector usage ledger for non-AI tools (MCP/HTTP/web search/storage) with cost and unit fields: `api/prisma/schema.prisma:2275-2310`.
- Read API: token/connector/file usage summaries with grouping, plus a monthly estimate/forecast: `api/src/routes/ledger.ts:26-89`, `api/src/services/token-ledger.ts:6-372`.
- Admin UI: token usage page (group by model/provider/user/agent/run/channel), budget manager, pricing manager, storage usage meter: `admin/src/pages/TokenUsagePage.tsx`, `admin/src/components/features/budgets/BudgetManager.tsx`, `admin/src/components/features/budgets/PricingManager.tsx`, `admin/src/components/features/knowledge/StorageUsageMeter.tsx`.

## Gaps

### Spend cap is advisory-by-design — no hard pre-spend enforcement and unbounded concurrency overshoot
- Severity: critical
- Effort: L
- Description: As the CFO's deputy, this is the single fact that kills the deal. The cost cap is explicitly a SOFT cap: usage is recorded only after a run completes, the gate reads period-to-date totals at run START with no in-flight reservation, and there is no row lock or atomic reserve. So N parallel automation runs all read the same under-cap total, all pass, and collectively blow past the limit — exactly the "runaway agent burns $50k overnight" scenario. Worse, a live human turn passes by default even when over cap (`isHuman && !blockHumansWhenOver`), and the gate fires once per run, not per agentic iteration/tool-call, so a single run with 12 iterations × 20 tool calls can run far past the cap before the next run is gated. There is no mid-run kill. This is metering with a warning label, not a budget control.
- Evidence: `packages/runtime/src/budget.ts:21-22` (comment: "This is a SOFT cap: spend is recorded only after a run completes... can overshoot slightly"), `:202-230` (read-then-decide, no lock), `:227-229` (humans exempt by default); gate invoked once at `worker/src/run/execute/run-job.ts:79`, not inside the loop; absent: searched `budget.ts`, `budget-gate.ts`, `orchestrate.ts` for `lock|reserve|FOR UPDATE|in-flight|concurrent` — found nothing.
- Recommendation: Add a pre-spend reservation: estimate max run cost, atomically reserve against the period budget (DB row lock or an atomic `reserved_usd` counter), reject when reservation would exceed the cap, and reconcile actuals on completion. Enforce the gate per agentic iteration with a hard mid-run abort, and make the default for enforce mode block-everyone (humans included) for regulated tenants.

### Cost tracking is OFF by default — $0 until an owner manually types every model's rates
- Severity: critical
- Effort: M
- Description: Cost only exists if a pricing profile exists; `calculateEstimatedCost` returns `null` when there's no profile, and there is no seeded/default price book. The product even tells the user every cost shows $0 until they hand-enter rates. For an enterprise this means: out of the box there is no chargeback number, budgets keyed on `costLimitUsd` silently never trigger (the cap compares against $0 spend), and the forecast reads $0. Every model, every provider, every price change must be manually maintained per org — guaranteed to drift from real invoices, which is indefensible for chargeback to a cost center and for the licensing/usage contract.
- Evidence: `packages/runtime/src/ledger.ts:174-177` (`if (!pricing) return null`); `admin/src/pages/TokenUsagePage.tsx:162-163` ("Cost tracking is inactive — ... no model pricing is configured, so every cost shows $0"); absent: searched `api/`, `worker/`, `packages/` for `seed.*pric|default.*pric|DEFAULT_PRICING|builtinPricing` — found nothing.
- Recommendation: Ship a maintained default price book for the major providers/models (seeded, versioned, effective-dated) that orgs inherit and can override, so cost and budgets are correct on day one. Surface a "cost tracking healthy" status and warn loudly when ledger rows have null cost.

### No cost anomaly detection or proactive spend alerts
- Severity: high
- Effort: L
- Description: My core demand is "alert before a runaway agent burns the budget," not "show me the damage next month." There is no spike/anomaly detection, no scheduled budget-threshold notification, no rate-of-spend alarm. `warnThresholdPercent` exists but is only a passive level surfaced in a report someone has to open — nothing pushes a notification when an org crosses 80% or when hourly burn deviates from baseline. By the time anyone looks at the dashboard, the money is gone.
- Evidence: absent: searched `api/src`, `worker/src`, `packages` for `anomaly|spike|runaway|cost.*alert|budget.*alert` — only hit is an unrelated comment in `worker/src/run/schedule-tools.ts:289`; `warnThresholdPercent` is consumed only to compute a display `level` in `packages/runtime/src/budget.ts:252-253`.
- Recommendation: Add a scheduled spend evaluator that pushes alerts on threshold crossings and on burn-rate anomalies (e.g. hourly spend > Nx trailing baseline) to owners/finance via the existing notification/push channels, with per-scope routing.

### No chargeback/showback export or finance-role access to cost data
- Severity: high
- Effort: M
- Description: Chargeback to a department requires getting attributed cost OUT of the system into the GL/ERP — CSV/API export by cost center, with date ranges. There is no export anywhere (no CSV, no content-disposition, no raw-event export endpoint despite the spec listing one). The UI has no date-range picker; it shows fixed-period summaries only. And every ledger read is gated behind `requireOwner`, so a FinOps/finance analyst who is not an org owner cannot see costs at all — the spec itself admits team-scoped read access "is not yet implemented." There is also no cost-center/department dimension: attribution is org/project/team/agent/user, with no mapping to an accounting cost center.
- Evidence: absent: searched `api/src`, `admin/src` for `csv|text/csv|content-disposition.*ledger|ledger.*export` — found nothing; `api/src/routes/ledger.ts:29,52,71,85,93` all call `requireOwner`; spec confirms gap at `docs/token-ledger-spec.md:197-201`; no date-range inputs in `admin/src/pages/TokenUsagePage.tsx` (searched `from=|to=|dateRange|<input.*date` — none); no `costCenter`/department field on `Budget` or `TokenLedgerEvent` in `api/prisma/schema.prisma:2129-2229`.
- Recommendation: Add a finance/billing role with read-only ledger access; add a raw-event + summary CSV/Parquet export with arbitrary date range and group-by; add an optional cost-center/department tag on scopes and carry it on ledger rows for direct GL chargeback.

### No seat/license metering for the licensing contract
- Severity: high
- Effort: M
- Description: Procurement and the licensing contract are priced on seats / monthly active users. There is no billable-seat counter, no MAU rollup, no provable "active users this period" metric to true-up the contract or defend an audit. Usage metering is entirely token/byte/call-based; nothing counts or attests to human seats consumed.
- Evidence: absent: searched `api/src`, `packages` for `seat|licen[cs]e.*count|activeUsers|mau|billableUsers` — the only hits are unrelated tool-bundle `license` strings (`api/src/services/tool-bundles.ts:52`) and presence/status code; no seat or MAU model in `api/prisma/schema.prisma`.
- Recommendation: Add a billable-seat/MAU metering rollup (distinct active human actors per org per period from auth/activity), surfaced in admin and exportable, as the contractual usage metric.

### Estimated cost is never reconciled against actual provider invoices
- Severity: medium
- Effort: L
- Description: The ledger stores both `estimatedCostAmount` (from org pricing profiles) and `providerCostAmount` (provider-reported), but all budgets, forecasts, and dashboards run on the ESTIMATE. For a regulated finance review, an unaudited estimate that's never reconciled to the actual provider bill is a control weakness — pricing drift, token-counting differences, and missing cache-rate config silently diverge the chargeback number from the real invoice with no variance report.
- Evidence: `api/prisma/schema.prisma:2162-2170` (both `provider_cost_amount` and `estimated_cost_amount` columns exist); `packages/runtime/src/budget.ts:128-135` aggregates only `estimatedCostAmount`; summaries report both but there is no reconciliation/variance logic — searched `token-ledger.ts` for `reconcile|variance|invoice` — found nothing.
- Recommendation: Add an estimate-vs-provider variance report and a periodic reconciliation step; flag scopes where estimate diverges from provider-reported cost beyond a tolerance.

### Forecasting is a naive linear extrapolation, no per-scope or trend forecast
- Severity: low
- Effort: S
- Description: The only forecast is org-wide daily-rate × days-in-month, which over/under-shoots badly on spiky or growing workloads and isn't available per project/team/cost-center for departmental planning. Survivable, but not the defensible forecast a CFO planning chargeback wants.
- Evidence: `api/src/services/token-ledger.ts:345-372` (`dailyRate = total / daysElapsed; projected = dailyRate * daysInMonth`), org-scoped only; the spec promises "forecast by scope" (`docs/token-ledger-spec.md:178-179`) which is not implemented.
- Recommendation: Add per-scope forecasts with a trend/seasonality-aware model and expose budget-burndown projections per project/team.

## Top Priorities
- Convert the spend cap from advisory to enforceable: pre-spend reservation with atomic/locked budget accounting, per-iteration mid-run gating with hard abort, and a regulated-tenant default that blocks humans too — this is the gating item for any finance/security review.
- Ship a seeded, maintained default price book so cost, budgets, and forecasts are non-zero and correct out of the box, plus a "cost tracking healthy" health signal — without it every other cost number is $0 and every cost budget is inert.
- Add proactive spend protection and reporting: threshold + burn-rate anomaly alerts pushed to owners/finance, a read-only finance role, and CSV/API chargeback export with date range and cost-center tagging.
- Add seat/MAU metering as the contractual licensing metric, and an estimate-vs-provider-invoice reconciliation/variance report to make the chargeback number defensible.

## AI/agent governance for regulated enterprises

*Persona: Responsible-AI officer (egress/kill switch)*

## Maturity
early

## Current State
- Per-run safety budget is real and enforced: max 12 iterations / 20 tool calls / 90s wallclock / 50k tokens / 50 cost-cents / 75s per-tool timeout, plus loop-detection and a tool circuit breaker (`worker/src/run/agentic-loop.ts:32-39`, `:206-411`).
- Tool-grant enforcement exists at execution time: every non-`delegate` tool call is checked against the agent's resolved grant set and per-agent deny policy before running (`worker/src/run/execute/agent-loop.ts:243-271`, `worker/src/run/tool-policy.ts:24-48`).
- A deny-overrides RBAC policy engine evaluates `invoke` rules over an org→project→team→channel→agent→tool→user scope chain, with `deny`/`allow`/`requiresApproval` effects and time-window conditions (`api/src/services/policy.ts:99-199`, `worker/src/run/execute/policy.ts:143-215`).
- An SSRF guard blocks private/loopback/link-local/metadata destinations (DNS-resolved) for agent HTTP and MCP egress, and rejects credentialed/non-http(s) URLs (`packages/runtime/src/url-safety.ts:8-119`); model `backends` URLs are constrained to https and non-localhost at config load (`packages/config/src/index.ts:45-57`).
- A per-org/team budget gate runs before inference and can block or degrade-to-cheaper-model, exempting only live human turns (`worker/src/run/execute/budget-gate.ts:8-68`); spend is recorded per provider/model/agent/actor/run in a token ledger (`api/prisma/schema.prisma` `TokenLedgerEvent`, `worker/src/run/inference.ts:680-691`).
- An action audit log records policy denials and approvals with actor/tenant/resource/outcome (`worker/src/run/execute/policy.ts:217-264`, `api/src/services/approvals.ts:45-52`), and a per-run tool timeline stores tool name + input summary + truncated output preview (`api/prisma/schema.prisma` `ToolCall`).
- A per-org inference control plane data model exists with provider/model lifecycle (`draft`/`approved`/`deprecated`), `enabled` flags, and approver/approval-time columns (`api/prisma/schema.prisma` `InferenceProvider`/`InferenceModel`).

## Gaps

### Human-in-the-loop approval gate is non-functional — it denies but never pauses, requests, notifies, or resumes
- Severity: critical
- Effort: L
- Description: My single most important control does not exist in running code. The worker's "approval required" path returns a `tool_denied` result to the model and emits an audit row — it never calls `createApprovalRequest`, never sets the run to `waiting_approval`, never notifies an approver, and there is no resume path that consumes an `approvalProof`. So a "gated" irreversible action (send_message, message_delete, channel_archive, file_write, http POST) is simply refused mid-run; the agent is told "try a different approach" and barrels on. There is no way for a human to actually approve and let the action proceed. The approval service, continuation token, and `waiting_approval` status are all built but orphaned. For a regulated buyer this means the headline "human gate before irreversible agent actions" is vaporware — it fails a security review on the spot.
- Evidence: `worker/src/run/execute/agent-loop.ts:273-308` (denies, never creates a request); `worker/src/run/execute/policy.ts:188-201` (returns `approval_required`, no side effect); `grep` for `approvalRequest.create` / `createApprovalRequest` in `worker/` returned nothing (only the unused service at `api/src/services/approvals.ts:26`); `docs/approval-gating-spec.md:3` is labelled "target-state design for Phase 2."
- Recommendation: Wire the gate end-to-end: on `approval_required`, call `createApprovalRequest`, transition run→`waiting_approval`, persist the pending tool call + args under the continuation token, emit the `approval.needed` realtime event to policy-resolved approvers, and add a worker resume that re-injects the tool result with `approvalProof` after `resolveApprovalRequest`. Until then, stop marketing a human gate.

### The per-org "approved model" allow-list is not enforced on the agent execution path
- Severity: critical
- Effort: M
- Description: Data egress to third-party LLM providers is my central risk, and model governance is how I bound it. The control plane lets an org curate `enabled`+`approved` providers/models — but the only path agents ever run (`buildDirectRoute` → `routeSource: 'direct'`) does NOT require the model to be approved. `resolveStageProviderConfig` only throws on a missing approved provider/model when `routeSource === 'routing-profile'`, and routing profiles are dead code ("never reachable… have been removed"). On the direct path it silently falls back to legacy env-var API keys (`OPENAI_API_KEY`, etc.). So an agent's `provider`/`model` string is taken at face value and sent to whatever the global env key points at, regardless of whether the org approved that model. The allow-list is decorative.
- Evidence: `worker/src/run/inference.ts:645-673` (only direct route, profiles removed), `:307-309` (approval check guarded by `routeSource === 'routing-profile'`), `:327-331` (model-approval check same guard), `:339-347` (legacy env-key fallback); single global provider enum at `packages/config/src/index.ts:36`.
- Recommendation: Enforce `enabled = true AND lifecycle_status = 'approved'` for the `direct` route too — refuse to run any agent whose provider/model is not in the org's approved catalog, with no env-key fallback. Make the allow-list deny-by-default.

### No data-egress governance or content logging: what an agent sends to LLM providers / MCP endpoints is neither classified, restricted, nor recorded
- Severity: critical
- Effort: XL
- Description: I must be able to answer "what corporate data left to which third party, and can I prove zero-retention?" Nessie cannot. (1) No DPA/zero-retention posture is encoded — no provider attribute, no per-request retention/training-opt-out header, nothing in config or docs (`grep` for zero-retention/DPA found nothing). (2) Egress destinations are bounded only by the SSRF guard (block-private); there is no per-org allow-list of permitted external domains for `http_fetch`/MCP, so an agent (or a prompt-injected one) can exfiltrate to any public host. (3) Nothing records the actual prompt/response content sent to the provider — the token ledger stores only counts and cost; `ToolCall` stores a truncated 1200-char `outputPreview` and an input *summary*, not the payload. There is no DLP/PII scan before egress. So data egress is unbounded, ungoverned, and unloggable.
- Evidence: `worker/src/run/inference.ts:680-691` + `TokenLedgerEvent` (counts/cost only, no content); `worker/src/run/execute/agent-loop.ts:200` (`result.slice(0, 1200)`); `ToolCall` model is summary/preview only; SSRF guard `packages/runtime/src/url-safety.ts` blocks only private ranges; `grep` for `domainAllow`/`allowedHosts`/`egressAllow` and `zeroRetention`/`DPA`/`retention` headers found nothing.
- Recommendation: Add a per-org outbound domain allow-list for `http_fetch`/MCP; attach zero-retention/no-train headers per provider and surface a DPA/retention attribute in the inference control plane; add an optional content-egress log (hash + classification, or full content under retention policy) so a reviewer can prove what left and to whom; add a pre-egress PII/DLP scan hook.

### No prompt-injection or jailbreak defense for untrusted content fed into the agent
- Severity: critical
- Effort: L
- Description: I assume the agent will eventually be tricked — the whole question is what stops catastrophe then. Right now, nothing specific does. The system prompt is concatenated with raw conversation history and tool/document output and sent to the model with `toolChoice: 'auto'`; there is no trust-boundary separation between instructions and data, no injection/jailbreak detection, no spotlighting/delimiting of untrusted content, and no input/output moderation. `web_fetch`/`http_fetch`/`document_read`/KB content flow straight back into the loop as model-trusted text. The only "content filter" handling is classifying a *provider's* refusal error, not screening inputs. Combined with the broken approval gate and unbounded egress above, a single poisoned web page or document can redirect the agent to exfiltrate data or take actions — with no human gate to stop it.
- Evidence: `worker/src/run/execute/prompt.ts:5-70` (raw concatenation, no untrusted-content fencing); tool outputs re-injected verbatim at `worker/src/run/agentic-loop.ts:369-375`; `grep` for prompt-injection/jailbreak/moderation/guardrail returned only error-classification of provider `content_filter` (`worker/src/run/error-classification.ts:55-56`), not input screening.
- Recommendation: Fence untrusted tool/web/KB content with explicit delimiters and a "treat as data, never as instructions" system directive; add an injection/jailbreak classifier on tool outputs and user input; consider an output moderation pass before `send_message`/external egress.

### No kill switch: agents and AI cannot be stopped org-wide or per-agent
- Severity: high
- Effort: M
- Description: My non-negotiable is a kill switch — when something goes wrong I must halt all autonomous activity instantly. There is no org-level "disable all AI / pause all agents" control and no durable per-agent enable/disable/suspend flag. `Agent.status` is an ephemeral runtime state (`idle`/`thinking`/…/`offline`), not an administrative gate, and nothing in the execution path checks an "agent is disabled" condition before running. The only levers are deleting grants/policies or exhausting budget — slow, indirect, and not a one-switch stop. Triggers can be paused, but in-flight and human-invoked runs cannot be globally halted.
- Evidence: `AgentStatus` enum in `api/prisma/schema.prisma` (runtime states only); `Agent` model has no `enabled`/`disabled`/`suspended` column; `grep` for kill switch / pauseAll / disableAllAgents / aiEnabled across `api/src`, `worker/src`, `admin/src` found nothing; only `pauseAgentTrigger` exists (`api/src/services/trigger-crud.ts:403`).
- Recommendation: Add a durable `Agent.enabled` flag and an org-level `aiEnabled`/`agentsPaused` switch, checked at run admission in the worker; expose both as one-click admin controls. Make "halt" instantaneous and audited.

### No rollback / compensation for agent-made changes
- Severity: high
- Effort: L
- Description: When (not if) an agent acts wrongly, I need to undo it. There is no compensation, undo, or revert mechanism for agent side effects (messages sent, messages deleted, channels archived, files written/deleted, preferences changed). The only "undo" in the codebase is an upload-accounting cleanup, not an agent-action reversal. Without rollback, an irreversible-action gate is doubly important — and that gate is broken (above).
- Evidence: `grep` for rollback/undo/revert/compensat across `api/src`, `worker/src`, `packages` found only an upload accounting undo (`api/src/routes/uploads.ts:92`) and DB transaction `ROLLBACK`s (`packages/memory/src/search.ts:380`); no action-level compensation anywhere.
- Recommendation: For reversible builtins (message edit/delete, channel archive, file write) record a compensating action at execution time and expose an admin "revert this agent action / revert this run" operation tied to the audit/tool-call timeline.

### Audit & replay is incomplete: truncated tool I/O, no captured prompts, no DB-level immutability
- Severity: high
- Effort: L
- Description: The audit-trail spec promises an "immutable" log, but immutability is by convention only — there is no DB trigger, append-only constraint, or revoked UPDATE/DELETE grant, so a DB-level actor (or compromised app) can rewrite history. More importantly for me, I cannot *replay why an agent did something*: tool outputs are truncated to 1200 chars and inputs are stored as summaries (`ToolCall`), and the exact prompt/messages sent to the model are never persisted anywhere. So a post-incident "show me precisely what the agent saw and produced" is impossible. That fails forensic/regulatory replay requirements.
- Evidence: `ToolCall` model (`inputSummary`/`outputPreview` only) in `api/prisma/schema.prisma`; truncation at `worker/src/run/execute/agent-loop.ts:200`; no prompt persistence (`worker/src/run/inference.ts:680-691` stores ledger counts only); `grep` over migrations for audit immutability triggers/revokes found nothing; spec claims immutability at `docs/audit-trail-spec.md:14`.
- Recommendation: Add an optional full-fidelity run transcript store (prompt messages + complete tool inputs/outputs, under a retention policy and access-controlled) for replay; enforce audit-log immutability at the DB layer (append-only trigger or revoked UPDATE/DELETE).

### Approval authorisation is structurally sound but ungated upstream — it cannot fire
- Severity: medium
- Effort: S
- Description: Worth noting the *resolution* logic is actually good: no self-approval, live-membership role re-check (not stale JWT claims), atomic single-winner claim, TTL expiry with run-failover, and audit emission (`api/src/services/approvals.ts:121-214`). The weakness is purely that nothing upstream creates these requests (gap 1), so this otherwise-correct machinery is dead. I flag it medium only because the fix is small once gap 1 is wired — but it underscores that the approval feature shipped half-built.
- Evidence: `api/src/services/approvals.ts:140-162` (self-approval + live role check), `:178-197` (atomic claim), `:225-256` (expiry sweep) — all correct but reachable only via an HTTP resolve call, never from agent execution.
- Recommendation: Fold into gap 1; this code is the resolve half of the loop — connect the request/pause/resume half.

## Top Priorities
- Make the human-in-the-loop gate real end-to-end (request → pause `waiting_approval` → notify approver → resume with proof), then bind it to a curated set of irreversible builtins. This is the single control that turns "the agent got tricked" from catastrophe into a blocked, audited request.
- Enforce the per-org approved-model allow-list on the actual (direct) execution path with no env-key fallback, and encode data-egress governance: per-org outbound domain allow-lists for `http_fetch`/MCP, provider zero-retention/no-train posture, and a content-egress log — so I can bound and prove what corporate data leaves to which third party.
- Add prompt-injection/jailbreak defenses (fence untrusted tool/web/KB content as data, add an injection classifier and output moderation before egress), since you must assume the agent will be tricked.
- Ship an instantaneous kill switch (per-agent `enabled` + org-wide AI pause checked at run admission) and action-level rollback/compensation for agent side effects, plus full-fidelity replay transcripts and DB-enforced audit immutability.

## Deployment fit, extensibility & procurement enablement

*Persona: Platform-eng + vendor-risk gatekeeper*

## Maturity
early

## Current State
- Single Docker Compose stack for self-hosted prod (`api` + `worker` from one `Dockerfile.app`, static-nginx `admin`, dedicated `pgvector` Postgres, MinIO) — `infrastructure/compose/docker-compose.prod.yml:11-209`
- Multi-stage-ish Docker builds on `node:22-slim` / `nginx:alpine`, lint-gated inside the image build — `infrastructure/docker/Dockerfile.app:35-36`, `infrastructure/docker/Dockerfile.admin:28-29`
- Container/compose healthchecks for every prod service (Postgres, MinIO, API, admin, gateway) — `infrastructure/compose/docker-compose.prod.yml:31-35,118-123,170-174`
- Postgres-backed queue + realtime, so the stack has no Redis dependency to operate — `docs/deployment.md:38-39`
- CI runs lint, typecheck, build, and a Postgres-backed test job on every push — `.github/workflows/ci.yml:11-144`
- Automated deploy pipeline exists (push-to-main → SSH rsync → `redeploy.sh`) — `.github/workflows/deploy.yml:1-55`, `infrastructure/compose/redeploy.sh:1-78`
- 103 ordered Prisma migrations with `prisma migrate deploy` applied on every redeploy (forward schema evolution) — `api/prisma/migrations/`, `infrastructure/compose/redeploy.sh:54-55`
- A reasonably broad REST control plane (49 route modules incl. `audit-log`, `organizations`, `users`, `policy`, `ledger`) — `api/src/routes/`
- Per-org logo upload + a CSS-token theme switcher for light branding — `api/src/routes/organizations.ts:47-138`, `CLAUDE.md` Theming section
- Authoritative human-readable deploy runbook (first deploy, redeploy, config reference, MCP secret store) — `docs/deployment.md:1-320`

## Gaps

### Production is a hand-built single-VM snowflake — no Kubernetes/Helm, no registry, build-on-host
- Severity: critical
- Effort: XL
- Description: This is the exact pattern my estate rejects. Prod is one Docker Compose file on one Hetzner VM (`178.105.82.46`), deployed by `rsync`-ing the *working tree* to `/srv/nessie` and **building images on the production host** with `docker compose build`. Images are tagged `nessie-app:latest` / `nessie-admin:latest` and never pushed to any registry — so there is no immutable, versioned, scannable, signable artifact, and no way to promote the *same* bits dev→stage→prod. The deploy script itself documents that the shared host repeatedly filled to 100% disk and crashed Postgres mid-deploy (`PANIC: No space left on device`). I cannot run this under GitOps/Argo, cannot put it in our scanned-image pipeline, and cannot pin a release. There is no Helm chart, no Kustomize, no operator.
- Evidence: `infrastructure/compose/docker-compose.prod.yml:81-84,160-165` (`build:` + `image: …:latest`); `.github/workflows/deploy.yml:35-55` (rsync tree + SSH `redeploy.sh`); `infrastructure/compose/redeploy.sh:14-23,60-66` (build-on-host + disk-full history); absent: searched repo for `*.yaml`/`Chart.yaml`/`kustomization`/`ghcr.io`/`docker push`, found no Helm/k8s/registry publishing.
- Recommendation: Publish versioned, digest-pinned images to a registry (GHCR/Harbor) from CI with SemVer tags; ship a Helm chart (and/or Kustomize base) covering API/worker/admin + external Postgres/object-store dependencies; make compose the dev-only path. Decouple build from the production host entirely.

### Stale GCP Terraform shipped as the only IaC; actual prod has none
- Severity: critical
- Effort: L
- Description: The only Terraform in the repo provisions **GCP** (Cloud Run, Cloud SQL, Memorystore/Redis, Pub/Sub, KMS, GCS) — but `CLAUDE.md` states the GCP workflow is *retired* and prod is self-hosted Hetzner. So the IaC describes infrastructure that is not used, and the infrastructure that *is* used (Hetzner VM, Caddy, networks) has **no IaC at all** — it's manual SSH steps (append to a shared Caddyfile, `grep bootstrap` from logs, CLI `tsx` to grant super-admin). For my procurement and SRE teams this is worst-of-both: dead code that fails an architecture review, and a production estate I can't reproduce from declarative source. A "Redis module" in Terraform while docs say "No Redis" signals the IaC is unmaintained.
- Evidence: `infrastructure/terraform/main.tf:1-101` (google provider, cloud-run/cloud-sql/redis/pubsub/gcs/kms modules); `CLAUDE.md` ("It is **not** GCP Cloud Run — the old GCP workflow/spec are retired"); `docs/deployment.md:72-115` (manual first-deploy steps); absent: no Terraform/Ansible/Pulumi for the Hetzner target.
- Recommendation: Delete or clearly archive the GCP Terraform, and provide real IaC for the supported target (Helm values + a Terraform module for managed Postgres/object-store/secrets), so a customer can stand up an identical environment declaratively.

### Containers run as root; no image scanning, SBOM, or signing in the pipeline
- Severity: critical
- Effort: M
- Description: A blocking item on every container-security questionnaire. None of the three Dockerfiles set a non-root `USER` — API, worker, and the nginx admin all run as root (`node:22-slim`/`nginx:alpine` default to root). Base images are floating tags (`node:22-slim`, `minio/minio:latest`, `minio/mc:latest`) with no digest pinning, so builds aren't reproducible. CI has zero security gates: no Trivy/Grype image scan, no `syft`/CycloneDX/SPDX SBOM, no Cosign signing, no dependency CVE scan. In a regulated estate with admission control (e.g. non-root + signed-image policy), these images won't even schedule, and I have nothing to attach to a vendor-risk SBOM request.
- Evidence: `infrastructure/docker/Dockerfile.app:10-42`, `Dockerfile.admin:7-37`, `Dockerfile.gateway:2-26` (no `USER`, floating base tags); `docker-compose.prod.yml:40,62` (`minio:latest`); `.github/workflows/ci.yml:11-144` (lint/typecheck/build/test only); absent: searched for `trivy|grype|syft|sbom|cosign|cyclonedx|spdx`, found nothing in CI.
- Recommendation: Add `USER node` (and a non-root nginx/distroless variant), pin base images by digest, and add CI stages for image scan (Trivy), SBOM generation (Syft → CycloneDX), and image signing (Cosign), failing the pipeline on criticals.

### No supported upgrade/rollback path, version policy, or backup/DR documentation
- Severity: critical
- Effort: M
- Description: My SRE team needs a documented version policy, a tested upgrade/rollback procedure, and a backup/restore/DR runbook before go-live — and a procurement security questionnaire (CAIQ/SIG) asks for all three explicitly. The deployment doc has no mention of rollback, upgrade compatibility, version/support policy, backup, restore, disaster recovery, or RTO/RPO. "Rollback" here means the SPA freshness-reload trick, not an application/DB rollback. Migrations are forward-only `migrate deploy`; the script even hand-patches a previously-interrupted migration, which tells me failed-deploy recovery is ad hoc. There is no Postgres/MinIO backup job in the stack at all.
- Evidence: `docs/deployment.md:142-175` (redeploy section, no rollback/backup); `redeploy.sh:44-55` (manual repair of an interrupted migration); absent: searched `deployment.md` for `rollback|upgrade|version polic|backup|restore|disaster|RTO|RPO`, found nothing; no backup service in `docker-compose.prod.yml`.
- Recommendation: Define a SemVer + support/EOL policy, document and test forward-upgrade + DB/app rollback, and ship a backup/restore runbook (Postgres PITR + MinIO replication) with stated RTO/RPO.

### No standards-based provisioning (SCIM), bulk import/export, or published API contract
- Severity: high
- Effort: L
- Description: At tens-of-thousands of users I provision via SCIM from our IdP and I will not click users in one at a time. There is no SCIM endpoint, no bulk user import/export, and — critically — **no OpenAPI/Swagger spec** for the REST surface, so my integration team has nothing machine-readable to build against and my security team can't diff the API contract. The "admin/provisioning API" is the same internal REST the SPA uses, undocumented as a contract.
- Evidence: absent: searched `api/src` for `scim`, found nothing; absent: searched for `openapi`/`swagger` and `openapi*.json|yaml`, found nothing; the bulk hits in `api/src/routes/{threads,tasks}.ts` are internal `bulkUpdate`, not user provisioning.
- Recommendation: Add a SCIM 2.0 Users/Groups endpoint, a bulk CSV/JSON user import/export, and generate+publish an OpenAPI 3 spec from the route schemas (Fastify can emit it from the Zod/JSON schemas already present).

### No outbound eventing/webhooks and no audit-log/SIEM export
- Severity: high
- Effort: M
- Description: To fit our estate the platform must push events outbound — webhooks to ServiceNow/Jira, and audit/security events to our SIEM (Splunk/Sentinel) via syslog/CEF or an export API. What exists is *inbound* trigger intake and an *internal* SSE realtime stream for the SPA (presence/channel scopes) — neither is an outbound integration surface. The audit-log route has no export, syslog, CEF, or streaming capability, so I can't meet log-retention/forwarding controls.
- Evidence: `api/src/routes/events.ts:20-40` (internal SSE for UI scopes); `api/src/routes/trigger-intake.ts` (inbound only); `api/src/routes/audit-log.ts` (no export — searched `export|syslog|siem|splunk|cef|stream`, none found); absent: no signed outbound webhook dispatcher (searched `outbound|outgoing.?webhook|signing.?secret|hmac`).
- Recommendation: Add an outbound webhook subsystem (subscriptions, HMAC-signed delivery, retries/DLQ) and an audit-log export/forwarder (S3 export + syslog/CEF stream) so the platform plugs into our SOC tooling.

### Marquee integrations (Slack/Teams/Jira/ServiceNow) are documentation only
- Severity: high
- Effort: XL
- Description: Integration breadth is a primary scoring axis for us, and the headline integrations don't exist in code. The Slack/Teams "hits" are source comments ("mirroring Slack's escalation order", "Slack-parity files slice"), the integration design doc is explicitly labelled "aspirational target-state design — not implemented in code", and the only real outbound third-party client is a one-endpoint GitHub-issue helper for the in-app feedback form. The connector story is MCP/custom-HTTP-connector plumbing, not turnkey ServiceNow/Jira/Teams integration my users expect day one.
- Evidence: `docs/external-tool-integration.md:1-3` ("aspirational target-state design — not implemented in code"); `api/src/services/messages.ts:99` and `api/src/contracts/messaging.ts:60` (Slack only in comments); `api/src/services/github.ts:1-3` ("Minimal GitHub REST client for the Feedback section… one endpoint"); absent: no Slack/Teams/Jira/ServiceNow client modules in `api/src`/`worker/src`.
- Recommendation: Build (or certify partner-built) first-class connectors for Slack/Teams/Jira/ServiceNow with documented scopes, or be explicit in the sales/security materials that these are roadmap, not shipping.

### No license/seat management or true white-labeling
- Severity: medium
- Effort: M
- Description: Procurement needs seat/entitlement enforcement and reporting tied to the contract; the "license" code in the repo is SPDX licensing metadata on tool bundles, not seat entitlements. Branding is limited to a single org-logo upload plus a CSS theme — there's no product-name/white-label override, per-tenant custom domain in code, or branded email templates, so I can't present this as our internal tool to end users.
- Evidence: `api/src/services/tool-bundles.ts`, `packages/schemas/src/tools.ts` (tool SPDX licensing, not seats); `api/src/routes/organizations.ts:47-138` (logo only); absent: searched `seat.?limit|maxUsers|entitlement`, found nothing user-facing.
- Recommendation: Add seat/entitlement tracking with admin reporting, and extend branding to product name, custom domain, and email templates for genuine white-labeling.

### No air-gapped/offline install story; build pulls from public registries at deploy time
- Severity: medium
- Effort: M
- Description: My regulated/air-gapped environments have no egress to npm, Docker Hub, or `api.anthropic.com`. The deploy builds on-host with `pnpm install --frozen-lockfile` and `corepack enable` (pulls from npm) and floating Docker Hub base images, so it cannot run disconnected. There's also no documented internal-mirror/offline-bundle path or model-provider-on-prem story for a no-egress install.
- Evidence: `infrastructure/docker/Dockerfile.app:16-27` (apt + corepack + pnpm install at build), `docker-compose.prod.yml:40,62` (Docker Hub `:latest` images); absent: no offline/air-gap section in `docs/deployment.md` (headings end at `SSO`).
- Recommendation: Ship pre-built registry images (removing build-at-deploy), document an air-gapped install with an internal registry/npm mirror, and pin/validate all dependencies for offline transfer.

## Top Priorities
- Stop building on the prod host: publish versioned, digest-pinned, **scanned + signed + SBOM'd, non-root** images to a registry from CI, and ship a **Helm chart** so the platform fits a Kubernetes/GitOps estate instead of a single-VM compose snowflake.
- Replace the dead GCP Terraform with real IaC for the supported target, and write the procurement-critical operational docs: version/support policy, tested upgrade **and rollback**, and a backup/restore/DR runbook with RTO/RPO.
- Add enterprise provisioning and contract surfaces: **SCIM 2.0** + bulk import/export, a published **OpenAPI** spec, outbound **webhooks**, and **audit-log/SIEM export**.
- Be honest in security/procurement materials that Slack/Teams/Jira/ServiceNow integrations, white-labeling, and seat/license management are roadmap — and prioritize at least SIEM export and SCIM to clear the first security review.
