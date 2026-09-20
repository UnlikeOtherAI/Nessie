import { invoke } from '@tauri-apps/api/core'
import { isDesktopApp } from './desktop'

export type LocalInferenceDesktopEnrollment = {
  authorizationRevision: number
  connectionEpoch: number
  publicKey: string
  requiresReconsent: boolean
}

const requireDesktop = (): void => {
  if (!isDesktopApp()) throw new Error('Open Nessie Desktop on the computer running Ollama to approve this model.')
}

/** Native, OS-confirmed operations. This module never discovers or calls Ollama. */
export const prepareLocalInferenceDesktopEnrollment = async (): Promise<LocalInferenceDesktopEnrollment> => {
  requireDesktop()
  return invoke<LocalInferenceDesktopEnrollment>('local_inference_prepare_desktop_enrollment')
}

/** Replaces a server-revoked local key only after Desktop's native repair
 * confirmation. The browser cannot mint or rotate a machine identity. */
export const rotateLocalInferenceDesktopMachineKey = async (): Promise<LocalInferenceDesktopEnrollment> => {
  requireDesktop()
  return invoke<LocalInferenceDesktopEnrollment>('local_inference_rotate_machine_key')
}

/** Starts the native direct host only after the server has assigned its host id. */
export const startLocalInferenceDirectHost = async (input: {
  hostId: string
  organizationId: string
}): Promise<void> => {
  requireDesktop()
  await invoke('local_inference_start_direct_host', {
    hostId: input.hostId,
    organizationId: input.organizationId,
  })
}

export const signLocalInferenceBindingConsent = async (input: {
  challengeId: string
}): Promise<string> => {
  requireDesktop()
  const result = await invoke<{ signature: string }>('local_inference_sign_binding_consent', {
    challengeId: input.challengeId,
  })
  return result.signature
}
