import type { RegisterDeviceRequest } from '@nessie/schemas'

type NativePushRegistrationClient = {
  post: (path: string, body: RegisterDeviceRequest) => Promise<{ ownershipProof?: string }>
}

type OwnershipProofStorage = Pick<Storage, 'getItem' | 'setItem'>

const ownershipProofStorageKey = (token: string): string => `nessie:native-push-ownership:${token}`
const deviceRecoveryKeyStorageKey = (token: string): string => `nessie:native-push-recovery:${token}`

const nativePushOwnershipStorage = (): OwnershipProofStorage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const readOwnershipProof = (storage: OwnershipProofStorage, token: string): string | undefined => {
  try {
    return storage.getItem(ownershipProofStorageKey(token)) ?? undefined
  } catch {
    return undefined
  }
}

const issueDeviceRecoveryKey = (): string | undefined => {
  if (typeof crypto === 'undefined') return undefined
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const readOrCreateDeviceRecoveryKey = (
  storage: OwnershipProofStorage,
  token: string,
): string | undefined => {
  try {
    const existing = storage.getItem(deviceRecoveryKeyStorageKey(token))
    if (existing && existing.length >= 32) return existing
    const issued = issueDeviceRecoveryKey()
    if (!issued) return undefined
    storage.setItem(deviceRecoveryKeyStorageKey(token), issued)
    return issued
  } catch {
    return undefined
  }
}

const storeOwnershipProof = (
  storage: OwnershipProofStorage,
  token: string,
  ownershipProof: unknown,
): void => {
  if (typeof ownershipProof !== 'string' || ownershipProof.length < 32) return
  try {
    storage.setItem(ownershipProofStorageKey(token), ownershipProof)
  } catch {
    // A full or unavailable WebView store leaves the existing binding intact;
    // the server still refuses a future cross-account transfer without proof.
  }
}

/**
 * The WebView owns the installation proof because it owns the authenticated
 * API call. Its recovery key is stored before the request so it survives a
 * lost response; the proof carries across a session switch and is replaced
 * only after the server confirms a transfer or tombstone revival.
 */
export const registerNativePush = async (
  apiClient: NativePushRegistrationClient,
  registration: RegisterDeviceRequest,
  storage: OwnershipProofStorage | null = nativePushOwnershipStorage(),
): Promise<void> => {
  const ownershipProof = storage ? readOwnershipProof(storage, registration.token) : undefined
  const deviceRecoveryKey = storage
    ? readOrCreateDeviceRecoveryKey(storage, registration.token)
    : undefined
  const result = await apiClient.post('/api/devices', {
    ...registration,
    ...(deviceRecoveryKey ? { deviceRecoveryKey } : {}),
    ...(ownershipProof ? { ownershipProof } : {}),
  })
  if (storage) storeOwnershipProof(storage, registration.token, result.ownershipProof)
}
