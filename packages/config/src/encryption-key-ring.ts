import { z } from 'zod'

const EncryptionKeyVersionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** Configuration for the independently rotated at-rest encryption root. */
export const EncryptionConfigSchema = z.object({
  activeKeyVersion: EncryptionKeyVersionSchema.optional(),
  keys: z.record(EncryptionKeyVersionSchema, z.string().min(16)).default({}),
  legacyKey: z.string().min(16).optional(),
}).superRefine((value, context) => {
  if (value.activeKeyVersion && !value.keys[value.activeKeyVersion]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'encryption.activeKeyVersion must name a configured encryption key.',
      path: ['activeKeyVersion'],
    })
  }
  if (!value.activeKeyVersion && Object.keys(value.keys).length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'encryption.activeKeyVersion is required when encryption.keys are configured.',
      path: ['activeKeyVersion'],
    })
  }
})
export type EncryptionConfig = z.infer<typeof EncryptionConfigSchema>

export type ResolvedEncryptionKeyRing = {
  activeVersion: string
  keys: Readonly<Record<string, string>>
  legacyKey?: string
}

/** Resolve the key ring once at startup; only local mode may use a fallback. */
export const resolveEncryptionKeyRing = (
  config: { encryption: EncryptionConfig; mode: 'hosted' | 'selfHosted' | 'local' },
  localFallback?: string,
): ResolvedEncryptionKeyRing => {
  const { activeKeyVersion, keys, legacyKey } = config.encryption
  if (activeKeyVersion) return { activeVersion: activeKeyVersion, keys, legacyKey }
  if (config.mode === 'local' && localFallback) {
    return {
      activeVersion: 'local-ephemeral',
      keys: { 'local-ephemeral': localFallback },
      legacyKey: localFallback,
    }
  }
  throw new Error(
    'A dedicated NESSIE_ENCRYPTION_KEY_RING and NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION '
      + 'are required outside local mode.',
  )
}

/** Parse the one environment object without ever reflecting key material. */
export const parseEncryptionKeyRingEnv = (
  value: string | undefined,
): Record<string, unknown> | undefined => {
  if (value === undefined || value === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('NESSIE_ENCRYPTION_KEY_RING must be a JSON object.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('NESSIE_ENCRYPTION_KEY_RING must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}
