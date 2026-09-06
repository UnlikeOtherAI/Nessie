import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/** Mirrors `SECRET_SCOPE_ORDER` in `secret-precedence.ts` (broadest first). */
const SecretRecordScopeTypeSchema = z.enum(['organization', 'team', 'project', 'personal'])

/**
 * The secret-metadata record the admin renders on the Secrets page. Lives
 * here — not `api/src/contracts/secrets.ts` — because the admin has no
 * import path into `api/src`; the API contract file re-exports this schema
 * so route handlers keep one import surface (docs/architecture.md, "shared
 * runtime schemas"). Metadata only: no value, ciphertext, or vault path is
 * ever part of this shape (docs/secret-management-spec.md → "Authority
 * split").
 */
export const SecretRecordSchema = z.object({
  reference: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  provider: z.string().nullable(),
  scopeType: SecretRecordScopeTypeSchema,
  scopeId: z.string().uuid(),
  locked: z.boolean(),
  rotatedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  status: z.enum(['active', 'revoked', 'expired']),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type SecretRecord = z.infer<typeof SecretRecordSchema>
