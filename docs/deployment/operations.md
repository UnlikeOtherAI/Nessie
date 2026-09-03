# Operating the host

Chapter of [deployment.md](../deployment.md). Disk and Docker build cache on a box shared with ~40 other apps, and the optional push relay.

## Host disk / Docker build cache (operational)

The host disk (`/`, ~300 GB) is **shared with other apps** on the box. Building
on it filled the disk to 100% on 2026-06-10 and crashed `nessie-postgres`
(`PANIC: could not write … No space left on device`, stuck in WAL recovery and
rejecting connections — which also blocks `prisma migrate deploy`). Routine
deploys no longer build here at all (see "Images are built on GitHub"), which
removed both the cache growth and the CPU/IO saturation. `redeploy.sh` still
waits for Postgres (`pg_isready`) before migrating, bounds the build cache used
by the local-build fallback (`docker builder prune -f --keep-storage 40GB`,
never `-af` — a full wipe forces that fallback to rebuild from scratch), prunes
dangling images, and removes superseded SHA-tagged Nessie release images.

If the disk fills anyway, the safe manual reclaim (does **not** touch named
volumes / running images): `docker builder prune -af` then `docker image prune
-f` (dangling only). Avoid `image prune -a` and `--volumes` on this shared host.
Check with `docker system df` / `df -h /`. Once space frees, Postgres finishes
recovery on its own and goes healthy.


## Push relay (optional)

The standalone `@nessie/gateway` push relay is deployable but gated behind the
Compose `push` profile, which `redeploy.sh` does not pass — it starts only when
an operator deliberately enables that profile.

Before enabling it, set the relay values in the host-only
`/srv/nessie/infrastructure/compose/.env` (do not commit real values):
`GATEWAY_API_KEY` (bearer token accepted by `POST /v1/push`); `PUSH_APNS_P8`,
`PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID`, `PUSH_APNS_TOPIC`, `PUSH_APNS_ENV`
(required together for APNs); `PUSH_FCM_SERVICE_ACCOUNT` (Firebase
service-account JSON, required for FCM).

Create a DNS-only A record for `push.unlikeotherai.com` → `178.105.82.46`, then
append a third Nessie site block to `/srv/infra/caddy/Caddyfile`, validating and
reloading Caddy after the edit:

```caddyfile
push.unlikeotherai.com {
  reverse_proxy nessie-gateway:5556
}
```

Build and start only the relay:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml \
  --profile push build nessie-gateway
docker compose -f infrastructure/compose/docker-compose.prod.yml \
  --profile push up -d nessie-gateway
```

Self-hosted instances should point at `https://push.unlikeotherai.com` once
their worker/API relay client wiring is enabled. This step only hosts the relay;
it does not make the Nessie API or worker call it yet.
