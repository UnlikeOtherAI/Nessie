import { z } from 'zod'

/**
 * Device-token registry — type contracts.
 *
 * Mobile apps register the *native* APNs/FCM device token of each install so
 * the push pipeline can target a user's devices (plan
 * `docs/plans/2026-06-07-native-apps-and-push.md` → "Device-token registry").
 * Backs the authenticated `/api/devices` endpoints. Tokens are user-scoped:
 * a caller only ever registers/removes tokens for themselves.
 */

export const DevicePlatformSchema = z.enum(['ios', 'android'])
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>

/** Body for `POST /api/devices` — register/refresh a native device token. */
export const RegisterDeviceRequestSchema = z.object({
  platform: DevicePlatformSchema,
  token: z.string().min(1),
  appVersion: z.string().min(1).optional(),
  /** APNs host selected by the native iOS build; absent for Android. */
  apnsEnvironment: z.enum(['sandbox', 'production']).optional(),
  /**
   * A high-entropy proof retained by the native installation. It is required
   * before the same physical push token can change people or organisations.
   */
  ownershipProof: z.string().min(32).max(256).optional(),
  /**
   * A high-entropy secret persisted by this WebView before it registers. The
   * server stores only its hash, so the installation can recover a lost proof
   * response without treating the provider token as possession evidence.
   */
  deviceRecoveryKey: z.string().min(32).max(256).optional(),
})
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>

/** A stored device-token row as returned to its owner. */
export const DeviceTokenRecordSchema = z.object({
  id: z.string().uuid(),
  platform: DevicePlatformSchema,
  token: z.string().min(1),
  appVersion: z.string().min(1).optional(),
  apnsEnvironment: z.enum(['sandbox', 'production']).optional(),
  /**
   * Returned only when this installation must retain a newly-issued proof.
   * It is never persisted in product state or returned by a device list.
   */
  ownershipProof: z.string().min(32).max(256).optional(),
  lastSeenAt: z.string().min(1),
  createdAt: z.string().min(1),
})
export type DeviceTokenRecord = z.infer<typeof DeviceTokenRecordSchema>
