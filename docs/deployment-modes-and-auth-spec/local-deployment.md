# Local deployment and baselines

> Part of [Deployment Modes and Authentication](overview.md).

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
