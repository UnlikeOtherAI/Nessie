import type { UoaSessionIdentity } from '@nessie/schemas'

export type ConsumeRefreshTokenResult =
  | {
      ok: true
      expiresAt: Date
      familyId: string
      rawToken: string
      replayed: boolean
      sessionId: string
      userId: string
      providerId: string
      providerType: string
      uoaIdentity?: UoaSessionIdentity
    }
  | { ok: false; reason: 'expired' | 'invalid' | 'reuse' }
