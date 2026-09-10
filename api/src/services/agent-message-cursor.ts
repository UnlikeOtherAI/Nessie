import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

const CURSOR_PREFIX = 'amc1.'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
export const AGENT_MESSAGE_CURSOR_TTL_MS = 10 * 60 * 1000

type AgentMessageCursor = {
  agentId: string
  createdAt: string
  id: string
  organizationId: string
  snapshotCreatedAt?: string
  snapshotId?: string
  userId: string
  expiresAt: number
  version: 1
}

export class AgentMessageCursorError extends Error {
  constructor() {
    super('Invalid agent message cursor')
  }
}

const cursorKey = (secret: string): Buffer =>
  createHash('sha256')
    .update('nessie.agent-message-cursor.v1\0')
    .update(secret)
    .digest()

const parseCursor = (value: unknown): AgentMessageCursor | null => {
  if (!value || typeof value !== 'object') return null
  const cursor = value as Partial<AgentMessageCursor>
  if (
    typeof cursor.agentId !== 'string'
    || typeof cursor.createdAt !== 'string'
    || typeof cursor.id !== 'string'
    || typeof cursor.organizationId !== 'string'
    || typeof cursor.userId !== 'string'
    || typeof cursor.expiresAt !== 'number'
    || cursor.version !== 1
    || cursor.agentId.length === 0
    || cursor.id.length === 0
    || cursor.organizationId.length === 0
    || cursor.userId.length === 0
    || !Number.isFinite(cursor.expiresAt)
    || Number.isNaN(new Date(cursor.createdAt).getTime())
    || (cursor.snapshotCreatedAt === undefined) !== (cursor.snapshotId === undefined)
    || (cursor.snapshotCreatedAt !== undefined
      && (typeof cursor.snapshotCreatedAt !== 'string'
        || Number.isNaN(new Date(cursor.snapshotCreatedAt).getTime())))
    || (cursor.snapshotId !== undefined
      && (typeof cursor.snapshotId !== 'string' || cursor.snapshotId.length === 0))
  ) return null
  return cursor as AgentMessageCursor
}

/**
 * Message history can advance across a withheld row. Its keyset is therefore
 * encrypted, rather than exposing a row the caller may not read, and bound to
 * the exact human, tenant, and agent that received it.
 */
export const encodeAgentMessageCursor = (
  cursor: Omit<AgentMessageCursor, 'expiresAt' | 'version'>,
  secret: string,
  now = new Date(),
): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv)
  const payload = Buffer.concat([
    cipher.update(JSON.stringify({
      ...cursor,
      expiresAt: now.getTime() + AGENT_MESSAGE_CURSOR_TTL_MS,
      version: 1,
    } satisfies AgentMessageCursor), 'utf8'),
    cipher.final(),
  ])
  return `${CURSOR_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64url')}`
}

export const decodeAgentMessageCursor = (
  token: string | undefined,
  input: Pick<AgentMessageCursor, 'agentId' | 'organizationId' | 'userId'> & { secret: string },
  now = new Date(),
): { createdAt: Date; id: string; snapshot?: { createdAt: Date; id: string } } | null => {
  if (!token) return null
  if (!token.startsWith(CURSOR_PREFIX)) throw new AgentMessageCursorError()

  try {
    const encrypted = Buffer.from(token.slice(CURSOR_PREFIX.length), 'base64url')
    if (encrypted.length <= IV_BYTES + AUTH_TAG_BYTES) throw new AgentMessageCursorError()
    const iv = encrypted.subarray(0, IV_BYTES)
    const tag = encrypted.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
    const payload = encrypted.subarray(IV_BYTES + AUTH_TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(input.secret), iv)
    decipher.setAuthTag(tag)
    const cursor = parseCursor(JSON.parse(Buffer.concat([
      decipher.update(payload),
      decipher.final(),
    ]).toString('utf8')))
    if (
      !cursor
      || cursor.agentId !== input.agentId
      || cursor.organizationId !== input.organizationId
      || cursor.userId !== input.userId
      || cursor.expiresAt < now.getTime()
    ) throw new AgentMessageCursorError()
    return {
      createdAt: new Date(cursor.createdAt),
      id: cursor.id,
      ...(cursor.snapshotCreatedAt && cursor.snapshotId
        ? { snapshot: { createdAt: new Date(cursor.snapshotCreatedAt), id: cursor.snapshotId } }
        : {}),
    }
  } catch (error) {
    if (error instanceof AgentMessageCursorError) throw error
    throw new AgentMessageCursorError()
  }
}
