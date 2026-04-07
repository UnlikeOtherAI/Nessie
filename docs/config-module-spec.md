# Config Module Spec

> Status: active target-state design.

## 1) Objective

All services must load one validated typed config object at startup.

Create one shared package:

- `packages/config`

This package owns:

- config schema definition
- config loading and override order
- runtime capability flags for degraded local/self-hosted modes

No service should read `process.env` directly outside this package.

## 2) Canonical schema

Use Zod for the full config tree.

```ts
const NessieConfig = z.object({
  mode: z.enum(['hosted', 'selfHosted', 'local']),
  auth: z.object({
    providers: z.array(AuthProviderConfig),
    autoRedirectToSso: z.boolean().default(false),
  }),
  database: z.object({
    url: z.string(),
    poolMin: z.number().default(2),
    poolMax: z.number().default(10),
  }),
  redis: z
    .object({
      url: z.string(),
      enabled: z.boolean().default(false),
    })
    .optional(),
  storage: z.object({
    provider: z.enum(['filesystem', 'gcs', 's3']),
    bucket: z.string().optional(),
    localPath: z.string().optional(),
  }),
  queue: z.object({
    provider: z.enum(['pubsub', 'local']),
    projectId: z.string().optional(),
  }),
});
```

Rules:

- validate once at startup
- fail hard on invalid or missing required fields
- return all validation errors in one startup report
- never keep handwritten TS-only config types separate from the Zod schema

## 3) Load order

Supported sources:

1. built-in defaults
2. optional `nessie.config.json`
3. environment variables
4. CLI flags

Later sources override earlier sources.

Environment variable mapping must be deterministic:

- `NESSIE_MODE` -> `mode`
- `NESSIE_AUTH_AUTO_REDIRECT` -> `auth.autoRedirectToSso`
- `NESSIE_DB_URL` -> `database.url`
- `NESSIE_REDIS_URL` -> `redis.url`
- `NESSIE_STORAGE_PROVIDER` -> `storage.provider`

## 4) Runtime capabilities

Services should branch on capability flags, not raw config internals.

```ts
type RuntimeCapabilities = {
  hasRedis: boolean;
  hasObjectStorage: boolean;
  hasExternalAuth: boolean;
  hasPubSub: boolean;
};
```

Rules:

- `hasObjectStorage = false` means filesystem adapter is active
- `hasExternalAuth = false` means bootstrap/local auth flow is active
- `hasPubSub = false` means in-process/local queue mode is active
- the launcher and `nessie local doctor` must read the same capability model

## 5) Phase 1 requirement

`packages/config` is a Phase 1 deliverable.

Phase 1 services must import typed config from this package:

- `/api`
- `/worker`
- `/admin` build-time env mapping only
- local launcher

## 6) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
- [implementation-phases.md](./implementation-phases.md)
