# First deploy, and the one-time setup after it

Chapter of [deployment.md](../deployment.md). Shared infra on the host, the first deploy from a dev machine, granting the first super-admin, sign-in branding, and the retired inference env refs.

## Shared infra (already on the host, do not disrupt)

`/srv/infra/docker-compose.yml` owns the `caddy` and shared `postgres`
containers and declares the external `edge` and `db` networks. Caddy mounts
`/srv/infra/caddy/Caddyfile`. Nessie only edits the marked
`# === Nessie production ===` site block in that Caddyfile — it never rewrites
unrelated site blocks. Keep the Nessie block above the direct-IP `:80` catch-all
so Caddy's host-specific HTTP redirects and ACME challenge handling win for
`nessie.works`. Other apps (voicepos, hugo) share the same proxy and networks.

Caddy mounts the file read-only (`./caddy/Caddyfile:/etc/caddy/Caddyfile:ro`).
After editing the host file, validate it with the same Caddy data volume and
recreate only the Caddy service so Docker remounts the current file inode:

```sh
cd /srv/infra
docker run --rm \
  -v /srv/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v infra_caddy_data:/data \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d --force-recreate caddy
```

## First deploy (from a dev machine)

Requires SSH access to the host and the Cloudflare full-token env var.

1. **DNS** — in the `nessie.works` Cloudflare zone, create DNS-only records:
   - `A nessie.works` → `178.105.82.46`
   - `CNAME www.nessie.works` → `nessie.works`
   - `A app.nessie.works` → `178.105.82.46`
   - `A api.nessie.works` → `178.105.82.46`

2. **Sync source** to the host build root:
   ```sh
   rsync -az --exclude '.git' --exclude '**/node_modules' --exclude '**/dist' \
     --exclude '.worktrees' --exclude '*.png' \
     ./ root@178.105.82.46:/srv/nessie/
   ```

3. **Create `/srv/nessie/infrastructure/compose/.env`** from
   `.env.prod.example`. Set a strong `NESSIE_DB_PASSWORD` (bound to the Postgres
   volume on first boot — do not change it afterwards), a 32-byte
   `NESSIE_AUTH_SECRET` (`openssl rand -hex 32`), `NESSIE_MODEL_PROVIDER`, and
   the model/tool API keys.

4. **Build, migrate, start** (see `redeploy.sh` for the scripted version):
   ```sh
   cd /srv/nessie
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d nessie-postgres
   docker compose -f infrastructure/compose/docker-compose.prod.yml build api admin web
   docker compose -f infrastructure/compose/docker-compose.prod.yml \
     run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:deploy
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d
   ```
   The production Dockerfiles run package lint before building. A lint failure
   is a build failure.

5. **Caddy** — add or update the Nessie site blocks in `/srv/infra/caddy/Caddyfile`
   (holding page → `nessie-web:80`, admin → `nessie-admin:80`,
   API → `nessie-api:5554`). Place the block above the direct-IP `:80`
   catch-all, then validate and recreate only Caddy:
   ```sh
   cd /srv/infra
   docker run --rm \
     -v /srv/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
     -v infra_caddy_data:/data \
     caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker compose up -d --force-recreate caddy
   ```

6. **First owner account** — Nessie runs in `selfHosted` mode with no users, so
   the API prints a one-time bootstrap URL on startup:
   ```sh
   docker compose -f infrastructure/compose/docker-compose.prod.yml logs api 2>&1 | grep bootstrap
   ```
   Open `https://app.nessie.works/bootstrap?token=<token>` and create the
   owner account. The token has a 15-minute TTL; restart the `api` service to
   mint a fresh one.

### Granting the first super-admin

The `/api/platform/push/*` credential-management endpoints, and the
push-credentials admin page that uses them, are gated by the platform-level
`users.super_admin` flag. After the owner account exists, grant that tier from
the deployed tree:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts grant-super-admin owner@example.com
```

To audit or remove the tier later:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts list-super-admins
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts revoke-super-admin owner@example.com
```

### Branding the sign-in screen

`GET /api/brand/logo` is public and unauthenticated: it paints the sign-in
screen for everybody reaching the instance, whatever organisation they belong
to. That makes it **instance** state, so the organisation whose logo it carries
is designated out of band by the instance operator — the same reasoning, and
the same CLI, as the super-admin tier above. Deliberately no API or admin-UI
surface: an org admin who could set it would be choosing the login screen for
every other tenant on the deployment.

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts show-instance-brand
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts set-instance-brand <organizationId>
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts clear-instance-brand
```

At most one organisation is designated (`Organization.instanceBrand`; setting
one clears the rest). With none designated — or when the designated
organisation has uploaded no logo — the endpoint 404s and the sign-in screen
falls back to the static Nessie mark. The designated organisation still uploads
and changes its own logo the ordinary way, at Settings → Appearance.

**An organisation's colour theme is not instance state and does not reach this
screen.** An org admin authors a palette at Settings → Organization →
Appearance, and it paints that organisation's people once they are signed in
and known. Before sign-in nobody knows which organisation the visitor belongs
to — and an instance routinely holds many — so `/login` renders the visitor's
own last built-in theme, or Sandstone. That is the same claim on the same
shared screen the instance brand exists to keep out of one tenant's hands. See
[docs/plans/2026-09-05-organisation-custom-theme.md](../plans/2026-09-05-organisation-custom-theme.md)
§4.3. Migration
`20260816100000_organization_instance_brand` backfills the designation on a
single-organisation instance, replacing the earlier implicit rule ("the
organisation's logo, if the instance holds exactly one organisation") that both
broke under per-UOA-organisation tenancy and handed one tenant's admins the
login screen everybody sees.

### Retired inference credential env references

Migration `20260816090000_retire_grandfathered_inference_env_refs` revokes every
`inference_credential_bindings` row that named a host environment variable — the
worker dereferenced it (`process.env[auth_secret_ref]`) and sent an arbitrary
deployment secret as a bearer token to the provider's own base URL. New writes
have been refused since the phase-0 secret-custody gate
(`INFERENCE_ENV_REF_FORBIDDEN`); this retires the rows written before it.

After deploying, **compiled providers** (`openai`, `deepseek`, `kimi`) keep
working on the deployment-level credential (`NESSIE_MODEL_API_KEY`) and need
nothing. Any **openai-compatible** provider that ran on such a binding is
disabled, marked `unreachable`, and reset to `draft` — its owner sees a disabled
provider rather than runs failing later with "Missing API key for provider …".
Restore one by configuring its credential at the deployment level; the control
plane will not accept a new env reference.
