import { z } from 'zod'

export const NessieModeSchema = z.enum(['hosted', 'selfHosted', 'local'])
export const AuthProviderTypeSchema = z.enum(['oidc', 'saml', 'uoa', 'local-bootstrap', 'custom'])
export const StorageProviderSchema = z.enum(['filesystem', 'gcs', 's3'])
export const QueueProviderSchema = z.enum(['pubsub', 'local'])

export const AuthProviderConfigSchema = z
  .object({
    providerId: z.string().min(1),
    type: AuthProviderTypeSchema,
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    autoRedirect: z.boolean().default(false),
    issuerUrl: z.string().url().optional(),
    clientId: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).default([]),
    mappingRules: z.record(z.unknown()).optional(),
  })
  .strict()

const NessieConfigObjectSchema = z
  .object({
    mode: NessieModeSchema.default('local'),
    auth: z
      .object({
        providers: z.array(AuthProviderConfigSchema).default([]),
        autoRedirectToSso: z.boolean().default(false),
      })
      .strict()
      .default({ providers: [], autoRedirectToSso: false }),
    database: z
      .object({
        url: z.string().min(1),
        poolMin: z.number().int().nonnegative().default(2),
        poolMax: z.number().int().positive().default(10),
      })
      .strict(),
    redis: z
      .object({
        url: z.string().min(1),
        enabled: z.boolean().default(false),
      })
      .strict()
      .optional(),
    storage: z
      .object({
        provider: StorageProviderSchema.default('filesystem'),
        bucket: z.string().min(1).optional(),
        localPath: z.string().min(1).optional(),
      })
      .strict()
      .default({ provider: 'filesystem' }),
    queue: z
      .object({
        provider: QueueProviderSchema.default('local'),
        projectId: z.string().min(1).optional(),
      })
      .strict()
      .default({ provider: 'local' }),
  })
  .strict()

export const NessieConfigSchema = NessieConfigObjectSchema.superRefine((config, ctx) => {
  if (config.database.poolMax < config.database.poolMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['database', 'poolMax'],
      message: 'database.poolMax must be greater than or equal to database.poolMin',
    })
  }
})

export const NessieConfigOverridesSchema = NessieConfigObjectSchema.deepPartial().strict()

export type NessieMode = z.infer<typeof NessieModeSchema>
export type AuthProviderType = z.infer<typeof AuthProviderTypeSchema>
export type StorageProvider = z.infer<typeof StorageProviderSchema>
export type QueueProvider = z.infer<typeof QueueProviderSchema>
export type AuthProviderConfig = z.infer<typeof AuthProviderConfigSchema>
export type NessieConfig = z.infer<typeof NessieConfigSchema>
export type NessieConfigInput = z.input<typeof NessieConfigSchema>
export type NessieConfigOverrides = z.input<typeof NessieConfigOverridesSchema>
