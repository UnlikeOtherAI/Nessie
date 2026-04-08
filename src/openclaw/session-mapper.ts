/**
 * src/openclaw/session-mapper.ts — Bidirectional mapping between
 * Nessie task/thread IDs and OpenClaw-compatible session keys.
 *
 * OpenClaw session keys follow: agent:<agentId>:<channel>:group:<groupId>
 * Nessie uses: taskId (UUID) + threadId (string).
 *
 * This mapper produces stable, hierarchical, collision-free keys.
 */

export interface NessieRef {
  taskId: string
  threadId: string
  parentTaskId: string | null
}

export interface OpenClawSessionKey {
  key: string
  agentId: string
  channel: string
  groupId: string
}

const NESSIE_CHANNEL = 'nessie'

/**
 * Convert a Nessie task reference to an OpenClaw session key.
 */
export function toOpenClawKey(ref: NessieRef): OpenClawSessionKey {
  const agentId = ref.threadId === 'main' ? 'orchestrator' : ref.threadId
  const groupId = ref.taskId
  const key = `agent:${agentId}:${NESSIE_CHANNEL}:group:${groupId}`
  return { key, agentId, channel: NESSIE_CHANNEL, groupId }
}

/**
 * Parse an OpenClaw session key back to a Nessie reference.
 * Returns null if the key does not follow the expected format.
 */
export function fromOpenClawKey(key: string): NessieRef | null {
  // agent:<agentId>:<channel>:group:<groupId>
  const parts = key.split(':')
  if (parts.length < 5 || parts[0] !== 'agent' || parts[3] !== 'group') {
    return null
  }
  const agentId = parts[1]!
  const groupId = parts.slice(4).join(':') // handle colons in groupId
  return {
    taskId: groupId,
    threadId: agentId === 'orchestrator' ? 'main' : agentId,
    parentTaskId: null, // not encoded in key; caller must resolve from ledger
  }
}

/**
 * Build a parent session key from a task's parent reference.
 */
export function parentKey(ref: NessieRef): string | null {
  if (!ref.parentTaskId) return null
  return toOpenClawKey({
    taskId: ref.parentTaskId,
    threadId: ref.threadId,
    parentTaskId: null,
  }).key
}
