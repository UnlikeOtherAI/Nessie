# Deployment Modes and Authentication

> Status: target-state design.

## 1) Objective

Nessie must support both:

- hosted SaaS deployment,
- self-hosted deployment on local or organization-owned infrastructure.

That includes very small installs such as:

- a Mac mini,
- a single Linux server,
- a local Docker environment on a developer machine.

The product architecture must therefore stay provider-agnostic at the core, even when GCP is the reference hosted deployment.

## 2) Deployment modes

### 2.1 Hosted SaaS mode

Reference target:

- Google Cloud deployment,
- managed multi-tenant service,
- default external auth endpoint at `authentication.unlikeotherai.com`,
- cloud-managed data stores and background execution.

### 2.2 Self-hosted organization mode

Target:

- deploy on customer infrastructure,
- still support multi-user org/team/channel/agent model,
- use customer-selected auth provider(s),
- use local or customer-managed infrastructure adapters for storage, queue, and secrets.

### 2.3 Single-machine local mode

Target:

- run the whole system locally on one machine,
- support both Docker-first and non-Docker startup,
- suitable for Mac mini, workstation, or small lab server,
- minimal dependency installation outside Docker.

The local mode should still use the same core control plane and data model, just with simpler infrastructure adapters.

## 3) Architecture rule

The core app must not hard-code GCP or a single auth provider into domain logic.

Keep abstracted:

- auth provider,
- object storage provider,
- queue/event bus,
- secret encryption backend,
- deployment-specific observability plumbing.

Do not abstract prematurely:

- Postgres-centric data model,
- control-plane schema,
- task/session/run lifecycle,
- policy model.

## 4) Authentication modes

### 4.1 Hosted default

Hosted Nessie should default to:

- `authentication.unlikeotherai.com` as the primary auth entrypoint,
- SSO-based login,
- optional step-up verification for privileged actions.

If the deployment is configured for a single upstream identity path, login may auto-redirect to the SSO provider instead of showing a chooser page.

### 4.2 Self-hosted auth model

Self-hosted Nessie must support a configurable provider system for authentication.

That means:

- one or more SSO providers may be configured,
- local deployments can choose their own identity provider,
- the login experience may either:
  - show a provider chooser,
  - or auto-redirect directly when exactly one provider is configured and `autoRedirectToSso=true`.

Supported auth-provider concept shape:

- `providerId`
- `type`
- `label`
- `enabled`
- `autoRedirect`
- `issuerUrl`
- `clientId`
- `scopes`
- `mappingRules`

Target provider types:

- OIDC
- SAML via gateway/adapter
- custom UOA adapter for `authentication.unlikeotherai.com`

### 4.3 Local login-page behavior

Local deployments must be able to disable forced auto-redirect.

Reason:

- when running locally, operators may want a visible login page with multiple configured SSO choices,
- they may not want browser flow to jump away immediately,
- local installs may also need a simpler bootstrap/admin onboarding flow.

Required config behavior:

- `auth.mode = hosted | selfHosted | local`
- `auth.autoRedirectToSso = true | false`
- `auth.providers = [...]`

### 4.3a Local bootstrap path

Fresh local installs need a concrete first-user bootstrap path even when no external SSO is configured yet.

Required behavior:

- first local launch may enter `bootstrap` mode,
- the launcher prints a bootstrap URL or one-time bootstrap token,
- the first operator creates the initial owner account,
- after bootstrap, the install can:
  - keep using local auth/bootstrap mode,
  - or switch to configured SSO providers,
  - or expose both according to policy.

This bootstrap path is mandatory for `nessie local up` to be usable on a fresh machine.

### 4.3b Phase 1 single-user simulation mode

Phase 1 may run in a single-user simulation mode after bootstrap.

Meaning:

- one real authenticated owner account exists,
- the broader org/project/team structure exists in the data model,
- but the install may operate with deterministic default container records instead of full multi-user setup.

Allowed Phase 1 approach:

- create one default organization,
- create one default project,
- create one default team,
- bind the owner user into them automatically,
- let channels and agents live inside that default containment model.

These IDs may be deterministic reserved IDs for local/bootstrap installs.

Guidance:

- deterministic seeded IDs are acceptable,
- avoid ad hoc per-page or per-feature fake identity generation,
- all actor context should resolve from the same auth/session source.

### 4.4 Model/provider auth separation

User authentication and model-provider authentication are separate concerns.

- user auth = who may enter and use Nessie,
- model auth = which API keys or provider accounts Nessie may use at runtime.

Model-provider auth should stay in the secret system, not in end-user SSO config.

### 4.5 Single source of truth for identity

There must be one canonical auth/session source for the product.

Rules:

- login state comes from one backend auth/session contract,
- current user identity comes from one canonical `me` endpoint,
- current org/project/team context comes from the same canonical session payload or follow-up bootstrap payload,
- frontend apps must consume this through one shared auth/session module.

Do not do this:

- every page calling its own auth helper,
- multiple frontend-only sources of truth for current user,
- ad hoc classes that separately reconstruct reusable auth/user objects.

Required Phase 1 contract shape:

- session token or equivalent credential
- `GET /api/auth/me`
- one shared frontend auth/session provider in `/admin`
- one canonical actor context passed to agent/runtime calls

## 5) Local deployment and startup

### 5.1 Docker-first local install

Local Nessie must be runnable entirely through Docker without requiring complex host-level installs.

Target local experience:

- install one lightweight launcher globally,
- run one command,
- all required local services start in Docker,
- all persisted state lands locally on the machine.

### 5.1a Non-Docker local install

Nessie must also support a first-class non-Docker local install path.

Reason:

- some operators do not want Docker at all,
- some local hosts already run system services directly,
- some users want lower overhead on Mac mini or workstation setups.

The non-Docker path should still be easy, but it must be honest about required dependencies.

### 5.1b Local dependency model

Required local dependency for non-Docker mode:

- PostgreSQL

Optional local dependencies:

- Redis
- MinIO or another S3-compatible local object store

Default local storage guidance:

- Postgres is required as the durable system of record,
- Redis is optional in early local mode and should only be required for features that truly depend on ephemeral coordination,
- MinIO should be optional because a local filesystem object-store adapter can serve as the simplest default for local installs.

Local object storage modes:

- `filesystem` adapter for simplest local installs,
- `minio` or `s3-compatible` adapter for users who want object-storage parity.

### 5.1c Degraded local mode

If optional dependencies are missing, Nessie should still start where possible and clearly describe degraded functionality.

Examples:

- without Redis:
  - reduced rate-limiting sophistication,
  - reduced ephemeral session/state performance,
  - some interactive/session-heavy features may be disabled or downgraded.
- without MinIO:
  - use local filesystem object storage,
  - signed URL parity may be reduced or implemented locally.

The launcher must report these degradations explicitly instead of failing silently.

### 5.2 Global launcher requirement

There should be a simple global command path for local installs.

Example target experience:

```bash
npm install -g nessie
nessie local up
```

Equivalent launcher forms may also exist:

- `pnpm dlx nessie local up`
- `npx nessie local up`

But the product should explicitly support the "simple global install and launch" path.

### 5.3 Local launcher responsibilities

The local launcher should:

- generate local config,
- start Docker Compose or equivalent local stack when Docker mode is selected,
- start app processes directly when non-Docker mode is selected,
- create local storage directories,
- open the local app URL,
- print bootstrap/admin login information,
- manage stop/restart/update commands,
- detect missing dependencies and recommend install steps per OS.

Suggested commands:

- `nessie local up`
- `nessie local down`
- `nessie local status`
- `nessie local logs`
- `nessie local reset`
- `nessie local doctor`

Suggested launcher behavior:

- `nessie local up --docker`
- `nessie local up --no-docker`
- `nessie local doctor`
  - checks `postgres`
  - checks optional `redis`
  - checks optional `minio`
  - reports current object-storage mode
  - prints install guidance for macOS, Linux, or Windows

### 5.4 Local persistence requirement

For local mode, all persistent data should land locally by default:

- Postgres data volume,
- object storage volume or local object-store adapter,
- local secrets backend data,
- uploaded files and artifacts.

The launcher should make local data locations explicit and controllable.

## 6) Recommended self-hosted baseline

First-class self-hosted baseline:

- Docker Compose
- Postgres
- optional Redis
- local disk or S3-compatible object storage
- pluggable auth provider

This is the OSS-friendly path and should be documented as the main self-hosting story before more advanced Kubernetes guidance.

### 6.1 Recommended non-Docker baseline

First-class non-Docker local baseline:

- Postgres required
- optional Redis
- local filesystem object storage by default
- optional MinIO for S3-compatible local parity
- pluggable auth provider
- one global launcher command path that can guide dependency setup

This keeps non-Docker installs realistic without pretending the system has zero dependencies.

## 7) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [functionality.md](./functionality.md)
