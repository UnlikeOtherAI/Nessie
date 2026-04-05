# remote

Self-hosted zero-trust access server for the Helper project. Lets a single
user reach their own machines from anywhere without exposing any service to
the public internet.

Full design lives in [`../docs/remote/`](../docs/remote/):

- [brief.md](../docs/remote/brief.md) — architecture and component brief
- [techstack.md](../docs/remote/techstack.md) — chosen stack and libraries
- [sso.md](../docs/remote/sso.md) — SSO integration with
  `authentication.unlikeotherai.com`

## Run

```bash
cp .env.example .env
# fill in REMOTE_UOA_SHARED_SECRET and REMOTE_UOA_OWNER_SUB
go run ./cmd/control-server
```

Then:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

## Layout

```
cmd/control-server/   entry point
internal/             feature packages (auth, devices, sessions, nat, ...)
api/openapi/          OpenAPI 3 spec (source of truth for HTTP contract)
migrations/           SQL migrations applied via golang-migrate
```

Packages are added as the corresponding brief sections get implemented; the
scaffold ships only `cmd/control-server` so the module compiles and runs
from day one.
