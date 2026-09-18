# Durable local state

Authoritative standard. [`AGENTS.md`](../../AGENTS.md) carries the one-line
summary and points here; **this file is the rule**.

## The rule

**Durable local state never lives inside the checkout.** Not in the primary
working tree, and above all not in a worktree under `.worktrees/` or
`.claude/worktrees/`.

Durable means "a person would mind losing it": the local database, uploaded
attachment and document bytes, anything holding a local install's identity.
A regenerated fixture — a self-signed certificate the mail-agent harness writes
before every run — is not durable and is exempt.

Two properties are required, and they are separate:

1. **Outlives the working tree.** Every worktree is temporary by design, and
   [`AGENTS.md`](../../AGENTS.md) → "Workflow" instructs every agent to remove
   its own once its branch merges.
2. **Shared by every working tree.** They all reach one local Postgres on
   `127.0.0.1:55432` through one container. State that is per-tree while the
   database is shared produces rows that name bytes no other tree can find.

`scripts/lint-local-state-paths.mjs` enforces both, and runs inside
`pnpm lint`.

## What this is written after

On 2026-09-18 the local Postgres kept its cluster in a bind mount at
`infrastructure/compose/../../.nessie/docker/postgres` — that is, inside
whichever working tree ran `docker compose up`. It happened to be
`.claude/worktrees/executor-page-admin-layout-f90378`. That branch merged, the
worktree was removed as the workflow requires, and the data directory went with
it. The container stopped. The next `docker start` found an empty directory,
ran `initdb`, and reported itself healthy. Every organisation, user, agent,
channel and auth session in the local install was gone, and nothing had
failed loudly at any point.

The filesystem blob store had the same shape plus a second fault. Its default
was `.nessie/storage` resolved against the working directory, so it was
per-tree while the database was shared: an agent's canonical Markdown, written
by the API running in one checkout, read back as "Markdown attachment bytes not
found" from another. `getStorage` also pasted the configured path onto
`process.cwd()` with `join`, which silently swallows an absolute path — so
configuring one's way out did not work either.

## How each one is anchored

- **Postgres** — the named Docker volume `nessie-local-postgres-data`, declared
  in `infrastructure/compose/docker-compose.yml`. Its `name:` is explicit and
  must stay explicit: Compose otherwise prefixes a volume with the project
  name, which it derives from the directory it was invoked from, so every
  working tree would get a volume of its own while sharing one
  `container_name` and one published port.
- **Filesystem storage** — `~/.nessie/storage`, absolute, built from
  `homedir()` in `packages/config/src/config-loader.ts` and mirrored in
  `packages/runtime/src/storage/index.ts` for a `StorageConfig` that carries no
  path. `NESSIE_STORAGE_LOCAL_PATH` overrides it. Local mode only: filesystem
  storage is a local-only capability and every other mode runs object storage.

## Moving an existing install

One time, per machine. A container created before this change still carries its
old bind mount — Compose does not re-mount a container that already exists, so
nothing changes until it is recreated.

**Check what you have.** If this prints a path rather than a volume name, the
old mount is still in place:

```bash
docker inspect nessie-local-postgres --format '{{range .Mounts}}{{.Type}} {{.Source}}{{end}}'
```

**If that path still exists and holds data you want**, copy it into the volume
before recreating the container. With the container stopped:

```bash
docker volume create nessie-local-postgres-data && docker run --rm -v nessie-local-postgres-data:/dest -v "<the path printed above>:/src:ro" alpine sh -c 'cp -a /src/. /dest/'
```

**Then recreate the container** so it picks up the new mount. This destroys the
container, not the data — the data is in the volume by now:

```bash
docker rm -f nessie-local-postgres && docker compose -f infrastructure/compose/docker-compose.yml up -d
```

**If the old path is gone** — the failure this standard is written after — there
is nothing to copy. Recreate the container as above, then rebuild the schema
and bootstrap an owner:

```bash
DATABASE_URL=postgresql://nessie:nessie@127.0.0.1:55432/nessie pnpm --filter @nessie/api prisma:migrate:deploy
```

The API prints a first-run setup URL on its next start; open it to create the
owner account.

**Storage bytes** move the same way, and are worth checking for separately:
anything under a `<checkout>/.nessie/storage` belongs in `~/.nessie/storage`
now. Copy each one in; the keys are content paths, so merging several trees'
stores is safe as long as nothing is overwritten.
