import {
  detectSecrets,
  extractDetectedSecretValue,
  redactDetectedSecrets,
  type DetectedSecret,
} from '@nessie/schemas'

import type { PersonalAssistantMention } from '../../shared/MentionInput'

export type SecretCaptureItem = {
  detected: DetectedSecret
  value: string
}

export type SecretCapture = {
  agentMentions: PersonalAssistantMention[]
  attachmentIds: string[]
  captureId: string
  currentIndex: number
  items: SecretCaptureItem[]
  replacementContent: string
  replacementMode: 'file' | 'message'
  savedNames: string[]
  scopeId?: string
  scopeType: 'personal' | 'project'
}

const captureId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

export const createSecretCapture = (input: {
  agentMentions?: PersonalAssistantMention[]
  attachmentIds?: string[]
  content: string
  projectId?: string | null
  replacementMode?: SecretCapture['replacementMode']
}): SecretCapture | null => {
  const matches = detectSecrets(input.content)
  if (matches.length === 0) return null
  return {
    agentMentions: input.agentMentions ?? [],
    attachmentIds: input.attachmentIds ?? [],
    captureId: captureId(),
    currentIndex: 0,
    items: matches.map((detected) => ({
      detected,
      value: extractDetectedSecretValue(input.content, detected),
    })),
    replacementContent: redactDetectedSecrets(input.content),
    replacementMode: input.replacementMode ?? 'message',
    savedNames: [],
    ...(input.projectId
      ? { scopeId: input.projectId, scopeType: 'project' as const }
      : { scopeType: 'personal' as const }),
  }
}

export const currentSecretCaptureItem = (capture: SecretCapture): SecretCaptureItem =>
  capture.items[capture.currentIndex]!

export const advanceSecretCapture = (
  capture: SecretCapture,
  savedName: string,
): SecretCapture | null => {
  const savedNames = [...capture.savedNames, savedName]
  if (capture.currentIndex + 1 >= capture.items.length) return null
  return { ...capture, currentIndex: capture.currentIndex + 1, savedNames }
}

export const protectedReplacement = (
  capture: SecretCapture,
  finalSavedName: string,
): string => {
  const names = [...capture.savedNames, finalSavedName]
  const notice = names.length === 1
    ? `[Secret protected and saved as ${names[0]}; the value was replaced.]`
    : `[Secrets protected and saved as ${names.join(', ')}; the values were replaced.]`
  return [notice, capture.replacementContent].filter(Boolean).join('\n\n')
}
