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

## 5.1) Phase 2 config additions

Phase 2 extends the config schema for hosted deployment. These fields are added to `NessieConfig`:

```ts
// Phase 2 additions to NessieConfig
kms: z
  .object({
    provider: z.enum(['cloudkms', 'local']),
    keyRing: z.string().optional(),       // e.g. 'nessie-staging'
    cryptoKey: z.string().optional(),     // e.g. 'nessie-tenant-secrets'
    projectId: z.string().optional(),     // GCP project ID
  })
  .optional(),
observability: z
  .object({
    tracing: z.boolean().default(false),
    tracingExporter: z.enum(['cloudtrace', 'otlp', 'console']).default('console'),
    otlpEndpoint: z.string().optional(),
  })
  .optional(),
pubsub: z
  .object({
    projectId: z.string(),
    topicPrefix: z.string().default('nessie'),  // physical topics: {prefix}-{logicalName}
  })
  .optional(),
identityPlatform: z
  .object({
    projectId: z.string(),
    apiKey: z.string(),
  })
  .optional(),
```

Phase 2 environment variable mappings:

- `NESSIE_KMS_PROVIDER` -> `kms.provider`
- `NESSIE_KMS_KEY_RING` -> `kms.keyRing`
- `NESSIE_KMS_CRYPTO_KEY` -> `kms.cryptoKey`
- `NESSIE_OBSERVABILITY_TRACING` -> `observability.tracing`
- `NESSIE_PUBSUB_PROJECT_ID` -> `pubsub.projectId`

Phase 2 RuntimeCapabilities additions:

```ts
// Phase 2 additions to RuntimeCapabilities
hasKms: boolean;          // true when kms.provider !== 'local'
hasTracing: boolean;      // true when observability.tracing === true
hasIdentityPlatform: boolean;  // true when identityPlatform is configured
```

## 5.2) Phase 3 config additions

Phase 3 extends the config schema for tooling, secrets, verification, knowledge base, and translation features. These fields are added to `NessieConfig`:

```ts
// Phase 3 additions to NessieConfig
secrets: z
  .object({
    masterKey: z.string().optional(),           // NESSIE_SECRETS_MASTER_KEY for local encryption
    kmsKeyRef: z.string().optional(),           // KMS key reference for hosted encryption
    cacheTtlMs: z.number().default(30000),      // in-memory secret cache TTL
  })
  .optional(),
toolRegistry: z
  .object({
    importPath: z.string().optional(),          // local path for manifest import
    marketplaceUrl: z.string().optional(),      // marketplace index URL
    requireSignature: z.boolean().default(false),
  })
  .optional(),
verification: z
  .object({
    emailOtp: z.object({
      enabled: z.boolean().default(true),
      codeLengthDigits: z.number().default(6),
      ttlMs: z.number().default(600000),        // 10 minutes
      resendCooldownMs: z.number().default(60000),
    }).optional(),
    emailLink: z.object({
      enabled: z.boolean().default(true),
      ttlMs: z.number().default(600000),        // 10 minutes
      baseUrl: z.string().optional(),            // confirmation page base URL
    }).optional(),
    totp: z.object({
      enabled: z.boolean().default(false),
      issuer: z.string().default('Nessie'),
    }).optional(),
  })
  .optional(),
knowledgeBase: z
  .object({
    storageProvider: z.enum(['filesystem', 'gcs', 's3']).optional(),
    localPath: z.string().optional(),
    maxDocSizeMb: z.number().default(50),
    searchDefaultLimit: z.number().default(25),
  })
  .optional(),
translation: z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai', 'anthropic', 'custom']).optional(),
    model: z.string().optional(),
    maxContextChars: z.number().default(4000),
    maxPreviousMessages: z.number().default(2),
  })
  .optional(),
```

Phase 3 environment variable mappings:

- `NESSIE_SECRETS_MASTER_KEY` -> `secrets.masterKey`
- `NESSIE_SECRETS_KMS_KEY_REF` -> `secrets.kmsKeyRef`
- `NESSIE_TOOL_REGISTRY_IMPORT_PATH` -> `toolRegistry.importPath`
- `NESSIE_TOOL_REGISTRY_MARKETPLACE_URL` -> `toolRegistry.marketplaceUrl`
- `NESSIE_VERIFICATION_EMAIL_OTP_ENABLED` -> `verification.emailOtp.enabled`
- `NESSIE_VERIFICATION_EMAIL_LINK_ENABLED` -> `verification.emailLink.enabled`
- `NESSIE_VERIFICATION_TOTP_ENABLED` -> `verification.totp.enabled`
- `NESSIE_VERIFICATION_TOTP_ISSUER` -> `verification.totp.issuer`
- `NESSIE_KB_STORAGE_PROVIDER` -> `knowledgeBase.storageProvider`
- `NESSIE_TRANSLATION_ENABLED` -> `translation.enabled`
- `NESSIE_TRANSLATION_PROVIDER` -> `translation.provider`

Phase 3 RuntimeCapabilities additions:

```ts
// Phase 3 additions to RuntimeCapabilities
hasToolRegistry: boolean;       // true when toolRegistry config exists
hasSecretVault: boolean;        // true when secrets config exists
hasStepUpVerification: boolean; // true when verification config exists with at least one factor enabled
hasKnowledgeBase: boolean;      // true when knowledgeBase config exists
hasTranslation: boolean;        // true when translation.enabled === true
```

## 6) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
- [implementation-phases.md](./implementation-phases.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [tool-registry-spec.md](./tool-registry-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [step-up-verification-spec.md](./step-up-verification-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)
- [knowledge-base-requirements.md](./knowledge-base-requirements.md)
