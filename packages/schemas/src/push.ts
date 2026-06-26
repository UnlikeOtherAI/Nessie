import { z } from 'zod'

/**
 * Push-credentials platform surface — type contracts.
 *
 * Backs the super-admin-only `/api/platform/push/*` endpoints (plan
 * `docs/plans/2026-06-07-native-apps-and-push.md` → "Push credentials —
 * super-user upload"). These describe the Apple APNs / Google FCM credentials
 * the central push gateway uses.
 *
 * Hard rule: secret bytes (the `.p8` key, the FCM service-account JSON) are
 * WRITE-ONLY. They are accepted on upload and stored encrypted via the
 * SecretStore; they never appear in any response shape below.
 */

// Credential-upload providers only. Browser Web Push has no uploaded credential
// (it uses the instance VAPID env keys), so it is intentionally absent here; the
// `webpush` value lives only in the Prisma `PushProvider` enum for delivery logs.
export const PushProviderSchema = z.enum(['apns', 'fcm'])
export type PushProvider = z.infer<typeof PushProviderSchema>

export const PushDeliveryStatusSchema = z.enum(['sent', 'failed', 'dead'])
export type PushDeliveryStatus = z.infer<typeof PushDeliveryStatusSchema>

export const PushApnsEnvironmentSchema = z.enum(['sandbox', 'production'])
export type PushApnsEnvironment = z.infer<typeof PushApnsEnvironmentSchema>

/**
 * APNs metadata uploaded alongside the `.p8` file. `keyId` is optional on the
 * wire because the server auto-derives it from an `AuthKey_<KEYID>.p8`
 * filename; a value supplied here wins over the derived one.
 */
export const ApnsUploadFieldsSchema = z.object({
  keyId: z.string().min(1).optional(),
  teamId: z.string().min(1),
  topic: z.string().min(1),
  // Optional on the wire; the service defaults a missing value to `production`.
  environment: PushApnsEnvironmentSchema.optional(),
})
export type ApnsUploadFields = z.infer<typeof ApnsUploadFieldsSchema>

/** Per-provider status block returned by `GET /api/platform/push/status`. */
export const ApnsStatusSchema = z.object({
  configured: z.literal(true),
  keyId: z.string(),
  teamId: z.string(),
  topic: z.string(),
  environment: PushApnsEnvironmentSchema,
  updatedAt: z.string(),
  updatedByUserId: z.string(),
})
export type ApnsStatus = z.infer<typeof ApnsStatusSchema>

export const FcmStatusSchema = z.object({
  configured: z.literal(true),
  projectId: z.string(),
  clientEmail: z.string(),
  updatedAt: z.string(),
  updatedByUserId: z.string(),
})
export type FcmStatus = z.infer<typeof FcmStatusSchema>

const NotConfiguredSchema = z.object({ configured: z.literal(false) })

export const PushStatusResponseSchema = z.object({
  apns: z.union([ApnsStatusSchema, NotConfiguredSchema]),
  fcm: z.union([FcmStatusSchema, NotConfiguredSchema]),
})
export type PushStatusResponse = z.infer<typeof PushStatusResponseSchema>

/** Result of validating/storing a credential, or of a `test` call. */
export const PushCredentialResultSchema = z.object({
  provider: PushProviderSchema,
  ok: z.boolean(),
  message: z.string(),
})
export type PushCredentialResult = z.infer<typeof PushCredentialResultSchema>

/** Optional body for `POST /api/platform/push/test`. */
export const PushTestRequestSchema = z.object({
  provider: PushProviderSchema,
  deviceToken: z.string().min(1).optional(),
})
export type PushTestRequest = z.infer<typeof PushTestRequestSchema>

export const PushTestResultSchema = z.object({
  provider: PushProviderSchema,
  ok: z.boolean(),
  message: z.string(),
  /** True when a real send to a supplied device token was attempted. */
  delivered: z.boolean().optional(),
})
export type PushTestResult = z.infer<typeof PushTestResultSchema>
