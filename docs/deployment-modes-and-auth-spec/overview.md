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

## Chapters

- [Authentication](authentication.md) — auth modes, bootstrap, session/JWT
  contract, refresh families, UOA renewal/workspace switching, profile mirror,
  rosters and invitations, middleware.
- [Local deployment and baselines](local-deployment.md) — local/docker
  startup, launcher, persistence, recommended self-hosted baselines.

## 7) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [functionality.md](./functionality.md)
