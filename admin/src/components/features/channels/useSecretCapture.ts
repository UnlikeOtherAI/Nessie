import { useCallback, useState } from 'react'
import {
  detectSecrets,
  extractDetectedSecretValue,
  redactDetectedSecrets,
  type DetectedSecret,
} from '@nessie/schemas'
import type { AgentMention } from '../../shared/MentionInput'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import type { ChannelRecord } from '../../../lib/api-client'

/**
 * A credential a composer stopped before sending
 * (docs/secret-management-spec.md → "Capture and ingestion"). `value` is the
 * only copy of the raw bytes, and it lives nowhere but here until the vault
 * POST in `SecretCaptureDialog` succeeds. It is saved as Personal unless the
 * person picks `projectId`, which is offered and never preselected.
 */
export type SecretCapture = {
  agentMentions: AgentMention[]
  detected: DetectedSecret
  projectId?: string
  replacementContent: string
  replacementMode: 'file' | 'message'
  value: string
}

/**
 * The project a capture in `room` may offer beside Personal, or null.
 *
 * Only an ordinary room of a project offers one, and only to an organisation
 * owner: `POST /api/secrets` lets no other role write a project
 * (`canManageSecretScope`). A DM, a group DM or a system conversation is
 * stored in its team's own project whoever it addresses, and a standalone
 * room in a hidden container, so neither project is the room's audience.
 */
export const secretCaptureProjectId = (
  room: ChannelRecord | null,
  { viewerIsOwner }: { viewerIsOwner: boolean },
): string | null =>
  room
  && viewerIsOwner
  && room.type === 'standard'
  && room.scope === 'project'
  && !room.isGroupDm
  && !room.systemChannelType
    ? room.projectId
    : null

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
 * `projectId` is the project the capture may offer beside Personal, which a
 * composer posting into a room takes from `secretCaptureProjectId`; null
 * offers Personal only.
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
        ...(projectId ? { projectId } : {}),
        replacementContent: redactDetectedSecrets(text),
        replacementMode: context.replacementMode,
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
