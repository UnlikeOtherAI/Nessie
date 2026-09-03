# Why the production stack looks like this

Chapter of [deployment.md](../deployment.md). The dedicated pgvector Postgres, one backend image, the static admin, proxy trust, and the two Infisical vault projects.

## Why these choices

- **Dedicated Postgres, not the shared one.** Nessie's migrations require the
  `vector` extension (`CREATE EXTENSION vector`, `vector(1024)` columns). The
  host's shared `postgres:17-alpine` lacks pgvector, so Nessie runs its own
  `pgvector/pgvector:pg17` container on the shared `db` network. Fully additive —
  it does not touch the shared Postgres or any other app's data. **The Compose
  service is named `nessie-postgres`, never `postgres`:** the service name becomes
  a DNS alias on the shared `db` network, so naming it `postgres` would collide
  with the shared Postgres container and make `postgres:5432` round-robin between
  two databases, breaking every other app on the host.
- **Nessie has no Redis dependency.** Its job queue and realtime transport are
  Postgres-backed (`PgQueueProvider` / `PgRealtimeTransport`). Infisical has a
  separate private Redis sidecar for its own sessions and background work.
- **One backend image for API + worker.** The team is tightly interlinked
  (`@nessie/api` depends on `@nessie/worker`, both need the Prisma client). A
  single full-team image (`Dockerfile.app`) builds everything once; the
  worker container overrides the command to `node worker/dist/index.js`.
- **Admin is built static, and the two origins are not interchangeable.**
  `Dockerfile.admin` bakes `VITE_API_BASE_URL=https://api.nessie.works` into the
  Vite bundle and serves it with nginx, so the admin calls the API
  cross-origin and `NESSIE_CORS_ORIGINS` allowlists `https://app.nessie.works`
  plus the legacy admin alias. Every built admin artifact — including the Tauri
  desktop app when it embeds `admin/dist` — must use the **api** origin:
  building with `https://app.nessie.works` makes `/api/auth/providers` resolve
  to the admin HTML shell, leaving login stuck at "Loading providers...".
- **Desktop CORS is deliberate.** The Fastify CORS policy always allows the
  fixed Tauri app origins (`tauri://localhost` and `http://tauri.localhost`)
  alongside the configured web admin origin, so embedded desktop builds can call
  `https://api.nessie.works` directly.
- **Proxy trust is explicit.** The API uses Fastify's configured proxy trust
  rather than parsing `X-Forwarded-For` itself. Production behind Caddy sets
  `NESSIE_API_TRUSTED_PROXY_HOPS=1`; local and unproxied deployments default to
  `0`, so forwarded client IP headers are ignored.

### Personal model subscriptions vault

Personal model subscriptions (a person's own Kimi/GLM plan powering the agents
they own) keep their token bundles in a **dedicated, separately-ACLed Infisical
project** — never the shared `/nessie/<org>/personal/<user>` partition, which
also holds a person's ordinary captured secrets and would hand any identity
scoped to it every one of them.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NESSIE_SUBSCRIPTION_VAULT_API_URL` | yes | Infisical API origin (HTTPS only). |
| `NESSIE_SUBSCRIPTION_VAULT_TOKEN` | yes | Machine-identity token scoped to the subscriptions project only. |
| `NESSIE_SUBSCRIPTION_VAULT_PROJECT_ID` | yes | The dedicated project id. |
| `NESSIE_SUBSCRIPTION_VAULT_ENVIRONMENT` | no | Defaults to `prod`. |

Both the API and the **worker** need these: inference runs in the worker, so it
holds its own machine identity for this project (the executor and agent
sandboxes still receive nothing). With any of the three unset, the feature is
simply unavailable — `/settings/connections` says so and linking is refused;
there is deliberately no PostgreSQL fallback. Because both services need them,
these four live in the Compose `.env` (which `api` and `worker` both read via
`env_file`), not in the API-only Docker secret that carries the Nessie Secrets
token. `.env` is rsync-excluded by the Deploy workflow, so the values persist
across every deploy.

#### Provisioning the subscriptions project

Production is provisioned (2026-09-02). To reproduce it on another instance,
create a **second project** and an identity scoped to it alone — never reuse
the Nessie Secrets project or its token. Using the instance admin identity
stored at `/srv/nessie-secrets/infisical-bootstrap.json`:

1. `POST /api/v2/team` — `{"projectName":"Nessie Subscriptions",
   "slug":"nessie-subscriptions","type":"secret-manager"}`. New projects come
   with `dev`/`staging`/`prod` environments; `prod` is what the default
   `NESSIE_SUBSCRIPTION_VAULT_ENVIRONMENT` expects.
2. `POST /api/v1/identities` with organisation role **`no-access`**, so the
   identity has no standing on anything else in the org.
3. `POST /api/v1/auth/token-auth/identities/{id}` with
   `accessTokenTTL: 0` / `accessTokenMaxTTL: 0` — the vault client holds a
   static bearer and has no refresh path, so an expiring token would silently
   break every subscription-routed run once it lapsed.
4. `POST /api/v2/team/{projectId}/identity-memberships/{identityId}` with
   role `admin` — project-scoped, so it grants nothing outside this project.
5. `POST /api/v1/auth/token-auth/identities/{id}/tokens` mints the bearer.
   Production keeps it at `/srv/nessie-secrets/infisical-subscriptions-token`
   (mode `0600`) and copies it into `NESSIE_SUBSCRIPTION_VAULT_TOKEN`.

Verify isolation before trusting it: the new token must round-trip a secret in
its own project **and** be refused (403) against `INFISICAL_PROJECT_ID`. That
refusal is the whole point of the separate project — it is what stops a
subscription-scoped identity from reading everyone's captured secrets.

Rotating is steps 3–5 again against the same identity, then updating `.env` and
recreating `api` + `worker`.

### Infisical vault

Infisical owns secret values and runs with Redis plus a dedicated `infisical`
database and database role on the existing `nessie-postgres` container. Before
the first deploy, create the database and role from the host without echoing a
password into shell history, then create `/srv/nessie-secrets/infisical-service-token`
with mode `0600`. Despite the legacy filename and environment-variable name,
this file contains a dedicated Infisical machine-identity access token. Set the
corresponding `INFISICAL_*` values in the Compose `.env`; create the separate
root-readable `.env.infisical` from
`infrastructure/compose/.env.infisical.example` for the vault database URI,
encryption key, and auth secret. The machine identity has `no-access` at the
Infisical organisation level and Developer membership only in the Nessie
Secrets project. Its access token is mounted only into `nessie-api` as a Docker
secret. Do not put any vault root material in
`.env` or pass it to `nessie-worker`.
The deployment mirror explicitly preserves `.env.infisical`, just as it
preserves `.env`; keep it host-only with mode `0600`.
Set `COMPOSE_PROFILES=secrets` only after all vault settings exist; this keeps
ordinary application deploys bootable while the vault has not been provisioned.

Add a `vault.unlikeotherai.com` DNS-only A record to the same host and a Caddy site
block that proxies only to `nessie-infisical:8080`. Validate the Caddyfile and
recreate Caddy as described below. After startup, create the Infisical admin,
project, `prod` environment, and the dedicated project-only API machine identity
described above. Record the project's ID in
`INFISICAL_PROJECT_ID`. Nessie derives every child path as
`/nessie/<organizationId>/<scopeType>/<scopeId>` from structural IDs only;
personal, team, project, and team secrets therefore cannot collide on a
display name. The stored vault reference records that exact path plus a
server-generated opaque secret name. On the first write, Nessie creates the
four namespace folders (`nessie`, organization, scope type, and scope ID) in
order; concurrent creation conflicts are safe to retry. Do not use tenant,
team, project, or person names in Infisical paths, and never log or return
vault values.
