import type { RegisterDeviceRequest } from '@nessie/schemas'

type NativePushRegistrationClient = {
  post: (path: string, body: RegisterDeviceRequest) => Promise<{ ownershipProof?: string }>
}

type OwnershipProofStorage = Pick<Storage, 'getItem' | 'setItem'>

const ownershipProofStorageKey = (token: string): string => `nessie:native-push-ownership:${token}`

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
 * API call. It carries the last proof across a session switch and replaces it
 * only after the server confirms a transfer or tombstone revival.
 */
export const registerNativePush = async (
  apiClient: NativePushRegistrationClient,
  registration: RegisterDeviceRequest,
  storage: OwnershipProofStorage | null = nativePushOwnershipStorage(),
): Promise<void> => {
  const ownershipProof = storage ? readOwnershipProof(storage, registration.token) : undefined
  const result = await apiClient.post('/api/devices', {
    ...registration,
    ...(ownershipProof ? { ownershipProof } : {}),
  })
  if (storage) storeOwnershipProof(storage, registration.token, result.ownershipProof)
}
