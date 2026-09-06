# Nessie Production Deployment

Authoritative guide for the self-hosted production deployment. This supersedes
the historical GCP Cloud Run plan (`docs/done/phase2-gcp-deployment-spec.md`).

## Overview

Nessie production runs as Docker containers on a single Hetzner host, reusing the
shared edge proxy (Caddy) and joining the shared Docker networks that already
host other apps on that box. TLS is automatic via Caddy + Let's Encrypt. DNS is
Cloudflare (DNS-only / grey-cloud, matching the other apps on the host).

| Component | URL | Container / DNS alias | Network(s) |
|-----------|-----|-----------------------|------------|
| Public holding page | `https://nessie.works` | `nessie-web` (nginx; alias, blue-green) | `edge` |
| Admin SPA | `https://app.nessie.works` | `nessie-admin` (nginx; alias, blue-green) | `edge` |
| API (REST + WS) | `https://api.nessie.works` | `nessie-api` (Fastify, 5554; alias, blue-green) | `edge`, `db` |
| Push relay (optional) | `https://push.unlikeotherai.com` | `nessie-gateway` (Fastify, 5556) | `edge` |
| Worker | — (no ingress) | `nessie-worker` | `db` |
| Postgres + pgvector | — (internal) | `nessie-postgres` (pg17) | `db` |
| Secret vault | `https://vault.unlikeotherai.com` | `nessie-infisical` | `edge`, private `vault` |

- **Host:** `178.105.82.46` (Hetzner, Ubuntu 24.04), SSH as `root`.
- **DNS zone:** `nessie.works` in Cloudflare (`ffc45bc029478feb510f8e5791feaf20`),
  nameservers `magali.ns.cloudflare.com` and `woz.ns.cloudflare.com`. The domain
  is registered at 123-reg; the registrar nameservers must point to those two
  Cloudflare nameservers before DNS activates.
- **Deploy root on host:** `/srv/nessie` (rsync'd working tree + build context).
- **Compose file:** `infrastructure/compose/docker-compose.prod.yml`.
- **Env file (host only, not committed):** `/srv/nessie/infrastructure/compose/.env`.
- **Legacy aliases during migration:** `https://nessie.unlikeotherai.com` still
  serves the admin and `https://api.nessie.unlikeotherai.com` still serves the
  API while clients move to the new domains.

## Chapters

The detail lives beside this page, one chapter per question, so an operator
reads the part they are actually doing. Each chapter is authoritative for
its area; this file is the map.

- **[Why the production stack looks like this](deployment/why-these-choices.md)** — The dedicated pgvector Postgres, one backend image, the static admin, proxy trust, and the two Infisical vault projects.
- **[First deploy, and the one-time setup after it](deployment/first-deploy.md)** — Shared infra on the host, the first deploy from a dev machine, granting the first super-admin, sign-in branding, and the retired inference env refs.
- **[Redeploying, and why it no longer takes the site down](deployment/redeploying.md)** — Images build on GitHub and the host only pulls; the swap is a health-gated blue-green rollout, gated again on the public endpoints.
- **[Supported upgrade paths and stuck migrations](deployment/upgrade-paths.md)** — What `prisma migrate deploy` is proven to converge from, how one failed migration parks every deploy after it, and the per-UOA-org partition.
- **[Operating the host](deployment/operations.md)** — Disk and Docker build cache on a box shared with ~40 other apps, and the optional push relay.
- **[Configuration reference](deployment/configuration.md)** — Config layering and the full environment-variable table: Google scopes and Meet, object storage, agent email, connected mailboxes, the MCP secret store.
- **[Google Cloud: the Cloud Run topology, and how to stand it up](deployment/gcloud.md)** — The terraform tree, the environment each service gets, the migrate job every rollout gates on, and what about that path is still unproven. Hetzner above is production; this one has never been applied.
- **[SSO (UnlikeOtherAuthenticator)](deployment/sso.md)** — How Nessie signs people in through UOA's config-JWT flow.
- **[Inference routing, embeddings and the vector width](deployment/inference-and-embeddings.md)** — Which Ledger adapter serves chat and embeddings, why the vector width is a schema change, and what a deployment with no UOA signer can do.
