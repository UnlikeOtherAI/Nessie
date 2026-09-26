import { useCallback, useState } from 'react'
import {
  detectSecrets,
  extractDetectedSecretValue,
  redactDetectedSecrets,
  type DetectedSecret,
} from '@nessie/schemas'
import type { AgentMention } from '../../shared/MentionInput'
import type { SecretRecord } from '../../../facades/secrets/hooks'

/**
 * A credential a composer stopped before sending
 * (docs/secret-management-spec.md → "Capture and ingestion"). `value` is the
 * only copy of the raw bytes, and it lives nowhere but here until the vault
 * POST in `SecretCaptureDialog` succeeds.
 */
export type SecretCapture = {
  agentMentions: AgentMention[]
  detected: DetectedSecret
  replacementContent: string
  replacementMode: 'file' | 'message'
  scopeId?: string
  scopeType: 'personal' | 'project'
  value: string
}

/** What a saved capture sends in place of the text it stopped. */
type SecretProtectedTurn = Pick<SecretCapture, 'agentMentions' | 'replacementMode'> & {
  content: string
}

/**
 * The one interception every message composer runs before a request. A draft
 * carrying a structural credential stops before a request, an optimistic row,
 * a browser notification or message memory can receive the material. The
 * person saves it to the vault or discards it; saving sends a new turn with
 * every detected value masked, discarding sends nothing.
 *
 * `projectId` is the project whose room the composer posts into, offered as
 * the capture's scope; null offers Personal only.
 */
export const useSecretCapture = ({ projectId }: { projectId: string | null }) => {
  const [capture, setCapture] = useState<SecretCapture | null>(null)

  /**
   * True when `text` carried a credential and is now held for the vault. The
   * caller must then drop every other copy it has of the text, and send
   * nothing.
   */
  const intercept = useCallback(
    (
      text: string,
      context: Pick<SecretCapture, 'agentMentions' | 'replacementMode'>,
    ): boolean => {
      const detected = detectSecrets(text)[0]
      if (!detected) return false
      setCapture({
        agentMentions: context.agentMentions,
        detected,
        replacementContent: redactDetectedSecrets(text),
        replacementMode: context.replacementMode,
        ...(projectId
          ? { scopeId: projectId, scopeType: 'project' as const }
          : { scopeType: 'personal' as const }),
        value: extractDetectedSecretValue(text, detected),
      })
      return true
    },
    [projectId],
  )

  /**
   * Called once the vault holds `secret`: drops the raw value before any chat
   * work and hands back the turn to send instead. It carries only the
   * scanner's replacement and the non-secret key the person approved.
   */
  const release = useCallback(
    (secret: SecretRecord): SecretProtectedTurn | null => {
      if (!capture) return null
      setCapture(null)
      return {
        agentMentions: capture.agentMentions,
        content: [
          capture.replacementContent,
          `[Secret protected and saved as ${secret.name}; the value was replaced.]`,
        ].filter(Boolean).join('\n\n'),
        replacementMode: capture.replacementMode,
      }
    },
    [capture],
  )

  const dismiss = useCallback(() => setCapture(null), [])

  return { capture, dismiss, intercept, release }
}
