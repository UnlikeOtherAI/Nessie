import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  canonicalDraftFingerprintInput,
  listGmailMailThreads,
  readGmailMailThread,
  GmailApiError,
} from '@nessie/comms-google'
import {
  ImapError,
  listMailboxMailThreads,
  readMailboxMailConversation,
  sendFromMailbox,
} from '@nessie/agent-mail'
import { safeFetch } from '@nessie/runtime'
import {
  capabilityIsGranted,
  ConnectedMailConversationSchema,
  ConnectedMailPageSchema,
  ConnectedMailThreadSummarySchema,
  getGoogleCapability,
  type ConnectedMailAccountRecord,
  type ConnectedMailConversation,
  type ConnectedMailboxSendInput,
  type ConnectedMailSource,
  type ConnectedMailThreadSummary,
} from '@nessie/schemas'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
  markCommsConnectionNeedsReauthorization,
} from './comms-credential-coordinator.js'
import {
  MailboxCredentialMissingError,
  mailboxDialOptions,
  mailboxEndpointsFor,
} from './mailbox-connection-endpoints.js'
import { markMailboxNeedsReauthorization } from './mailbox-connection-access.js'
import { mailboxConnectionTestFailure } from './mailbox-connections.js'

export type ConnectedMailErrorCode =
  | 'NOT_FOUND'
  | 'CAPABILITY_UNSUPPORTED'
  | 'NEEDS_REAUTHORIZATION'
  | 'DELIVERY_UNKNOWN'
  | 'PROVIDER_FAILED'

/** Foreign, stale and absent resources intentionally collapse to NOT_FOUND. */
export class ConnectedMailError extends Error {
  constructor(readonly code: ConnectedMailErrorCode) {
    super(`[connected-mail] ${code.toLowerCase().replaceAll('_', ' ')}`)
    this.name = 'ConnectedMailError'
  }
}

export type ConnectedMailDeps = {
  encryptionSecret: string
  fetchImpl?: typeof safeFetch
}

type Actor = { organizationId: string; userId: string }

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const gmailUsable = (
  row: { grantedScopes: unknown; disabledCapabilities: unknown },
  capability: 'gmail.read' | 'gmail.compose',
): boolean =>
  capabilityIsGranted(capability, strings(row.grantedScopes))
  && !strings(row.disabledCapabilities).includes(capability)

const mapCredentialError = (error: unknown): never => {
  if (!(error instanceof CommsCredentialCoordinatorError)) throw error
  if (error.code === 'NEEDS_REAUTHORIZATION') throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
  if (error.code === 'SCOPE_MISSING' || error.code === 'CAPABILITY_BLOCKED') {
    throw new ConnectedMailError('CAPABILITY_UNSUPPORTED')
  }
  throw new ConnectedMailError('NOT_FOUND')
}

const gmailFetch = (deps: ConnectedMailDeps) => async (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => (deps.fetchImpl ?? safeFetch)(url, init ?? {})

const mailboxForActor = async (
  prisma: PrismaClient,
  actor: Actor,
  id: string,
) => {
  const row = await prisma.mailboxConnection.findFirst({
    where: {
      id,
      organizationId: actor.organizationId,
      OR: [
        { ownerUserId: actor.userId },
        { team: { members: { some: { userId: actor.userId } } } },
      ],
    },
  })
  if (!row) throw new ConnectedMailError('NOT_FOUND')
  if (row.status === 'needs_reauthorization') {
    throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
  }
  if (row.status !== 'active') throw new ConnectedMailError('NOT_FOUND')
  return row
}

const gmailCredential = async (
  prisma: PrismaClient,
  actor: Actor,
  connectionId: string,
  deps: ConnectedMailDeps,
) => {
  try {
    return await loadUserGoogleCommsCredential(prisma, {
      capabilityId: 'gmail.read',
      connectionId,
      encryptionSecret: deps.encryptionSecret,
      organizationId: actor.organizationId,
      requiredScopes: getGoogleCapability('gmail.read').scopes,
      userId: actor.userId,
    })
  } catch (error) {
    return mapCredentialError(error)
  }
}

/** Every account this person can read now; stale team membership drops out live. */
export const listConnectedMailAccounts = async (
  prisma: PrismaClient,
  actor: Actor,
): Promise<ConnectedMailAccountRecord[]> => {
  const [gmail, mailboxes] = await Promise.all([
    prisma.commsConnection.findMany({
      where: {
        organizationId: actor.organizationId,
        ownerUserId: actor.userId,
        provider: 'google',
        status: { not: 'disconnected' },
      },
      select: {
        disabledCapabilities: true,
        externalUserId: true,
        grantedScopes: true,
        id: true,
        status: true,
      },
    }),
    prisma.mailboxConnection.findMany({
      where: {
        organizationId: actor.organizationId,
        OR: [{ ownerUserId: actor.userId }, { team: { members: { some: { userId: actor.userId } } } }],
      },
    }),
  ])
  return [
    ...gmail.map((connection) => ({
      address: connection.externalUserId,
      canCompose: connection.status === 'active' && gmailUsable(connection, 'gmail.compose'),
      canRead: connection.status === 'active' && gmailUsable(connection, 'gmail.read'),
      canSend: connection.status === 'active' && gmailUsable(connection, 'gmail.compose'),
      id: connection.id,
      label: connection.externalUserId,
      scope: 'personal' as const,
      source: 'gmail' as const,
      status: connection.status === 'active'
        ? 'active' as const
        : 'needs_reauthorization' as const,
    })),
    ...mailboxes.map((connection) => ({
      address: connection.address,
      canCompose: connection.status === 'active',
      canRead: connection.status === 'active',
      canSend: connection.status === 'active',
      id: connection.id,
      label: connection.label,
      scope: connection.ownerUserId ? 'personal' as const : 'shared' as const,
      source: 'mailbox' as const,
      status: connection.status === 'active'
        ? 'active' as const
        : connection.status === 'needs_reauthorization'
          ? 'needs_reauthorization' as const
          : 'disabled' as const,
    })),
  ]
}

const mapThreads = (items: Array<{
  id: string; from: string | null; subject: string; snippet: string; receivedAt: string | null
  unread: boolean; hasAttachments: boolean; messageCount: number
}>): ConnectedMailThreadSummary[] => items

const validatedPage = (page: {
  estimate?: number
  items: ConnectedMailThreadSummary[]
  nextCursor?: string
}): { estimate?: number; items: ConnectedMailThreadSummary[]; nextCursor?: string } =>
  ConnectedMailPageSchema(ConnectedMailThreadSummarySchema).parse(page)

const mapConversation = (conversation: {
  id: string
  messages: Array<{
    id: string; threadId: string; from: string | null; to: string[]; cc: string[]; subject: string
    receivedAt: string | null; body: string; bodyFormat: 'text' | 'html'; blockedRemoteContent: boolean
    attachments: { filename: string; contentType: string; sizeBytes: number }[]
    messageId: string | null; inReplyTo: string | null
  }>
}, earlierMessagesMayExist: boolean): ConnectedMailConversation => ({
  id: conversation.id,
  messages: conversation.messages,
  earlierMessagesMayExist,
})

export const listConnectedMailThreads = async (
  prisma: PrismaClient,
  actor: Actor,
  input: {
    source: ConnectedMailSource
    accountId: string
    cursor?: string
    pageSize: number
    query?: string
    unreadOnly?: boolean
  },
  deps: ConnectedMailDeps,
) => {
  if (input.source === 'gmail') {
    const credential = await gmailCredential(prisma, actor, input.accountId, deps)
    try {
      const page = await listGmailMailThreads(gmailFetch(deps), credential.credential.accessToken, input)
      return validatedPage({ ...page, items: mapThreads(page.items) })
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 401) {
        await markCommsConnectionNeedsReauthorization(prisma, credential.id)
        throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
      }
      if (error instanceof GmailApiError && error.scopeMissing) {
        throw new ConnectedMailError('CAPABILITY_UNSUPPORTED')
      }
      throw new ConnectedMailError('PROVIDER_FAILED')
    }
  }
  const connection = await mailboxForActor(prisma, actor, input.accountId)
  try {
    const page = await listMailboxMailThreads(
      await mailboxEndpointsFor(prisma, connection, deps.encryptionSecret),
      input,
      mailboxDialOptions(deps.encryptionSecret),
    )
    return validatedPage({ ...page, items: mapThreads(page.items) })
  } catch (error) {
    if (error instanceof MailboxCredentialMissingError || (error instanceof ImapError && error.kind === 'auth')) {
      await markMailboxNeedsReauthorization(prisma, connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    throw new ConnectedMailError('PROVIDER_FAILED')
  }
}

export const readConnectedMailConversation = async (
  prisma: PrismaClient,
  actor: Actor,
  input: { source: ConnectedMailSource; accountId: string; threadId: string },
  deps: ConnectedMailDeps,
): Promise<ConnectedMailConversation> => {
  if (input.source === 'gmail') {
    const credential = await gmailCredential(prisma, actor, input.accountId, deps)
    try {
      const conversation = await readGmailMailThread(
        gmailFetch(deps), credential.credential.accessToken, input.threadId,
      )
      return ConnectedMailConversationSchema.parse(
        mapConversation(conversation, conversation.earlierMessagesMayExist),
      )
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 401) {
        await markCommsConnectionNeedsReauthorization(prisma, credential.id)
        throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
      }
      if (error instanceof GmailApiError && error.status === 404) {
        throw new ConnectedMailError('NOT_FOUND')
      }
      if (error instanceof GmailApiError && error.scopeMissing) {
        throw new ConnectedMailError('CAPABILITY_UNSUPPORTED')
      }
      throw new ConnectedMailError('PROVIDER_FAILED')
    }
  }
  const connection = await mailboxForActor(prisma, actor, input.accountId)
  try {
    const conversation = await readMailboxMailConversation(
      await mailboxEndpointsFor(prisma, connection, deps.encryptionSecret), input,
      mailboxDialOptions(deps.encryptionSecret))
    if (!conversation) throw new ConnectedMailError('NOT_FOUND')
    return ConnectedMailConversationSchema.parse(
      mapConversation(conversation, conversation.earlierMessagesMayExist),
    )
  } catch (error) {
    if (error instanceof ConnectedMailError) throw error
    if (error instanceof MailboxCredentialMissingError || mailboxConnectionTestFailure(error) === 'credential_rejected') {
      await markMailboxNeedsReauthorization(prisma, connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    throw new ConnectedMailError('PROVIDER_FAILED')
  }
}

const mailboxSendFingerprint = (input: ConnectedMailboxSendInput): string =>
  createHash('sha256').update(canonicalDraftFingerprintInput(input)).digest('hex')

/** SMTP sends are only reached from an entitled human route and pin From to the connection. */
export const sendConnectedMailboxMail = async (
  prisma: PrismaClient,
  actor: Actor,
  accountId: string,
  input: ConnectedMailboxSendInput,
  deps: ConnectedMailDeps,
): Promise<{ status: 'sent'; actionId: string; messageId: string }> => {
  const connection = await mailboxForActor(prisma, actor, accountId)
  let endpoints
  try {
    endpoints = await mailboxEndpointsFor(prisma, connection, deps.encryptionSecret)
  } catch (error) {
    if (error instanceof MailboxCredentialMissingError) {
      await markMailboxNeedsReauthorization(prisma, connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    throw error
  }
  const fingerprint = mailboxSendFingerprint(input)
  const id = randomUUID()
  const domain = connection.address.split('@')[1] ?? 'localhost'
  const action = await prisma.mailboxSendAction.upsert({
    where: { connectionId_clientRequestId: { connectionId: connection.id, clientRequestId: input.idempotencyKey } },
    create: {
      id, organizationId: actor.organizationId, ownerUserId: actor.userId,
      connectionId: connection.id, clientRequestId: input.idempotencyKey,
      contentFingerprint: fingerprint, messageId: `nessie-${id}@${domain}`,
    },
    update: {},
  })
  if (action.contentFingerprint !== fingerprint || action.state === 'delivery_unknown') {
    throw new ConnectedMailError('DELIVERY_UNKNOWN')
  }
  if (action.state === 'dispatching') {
    await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN')
  }
  if (action.state === 'sent') {
    return { status: 'sent', actionId: action.id, messageId: action.messageId }
  }
  const claimed = await prisma.mailboxSendAction.updateMany({
    where: { id: action.id, state: 'ready' },
    data: { state: 'dispatching', claimedAt: new Date() },
  })
  if (claimed.count !== 1) throw new ConnectedMailError('DELIVERY_UNKNOWN')
  try {
    await sendFromMailbox(endpoints, {
      bcc: input.bcc, cc: input.cc, inReplyTo: input.inReplyTo,
      messageId: action.messageId, references: input.inReplyTo ? [input.inReplyTo] : undefined,
      subject: input.subject, text: input.body, to: input.to,
    }, mailboxDialOptions())
  } catch (error) {
    if (error instanceof MailboxCredentialMissingError || mailboxConnectionTestFailure(error) === 'credential_rejected') {
      await prisma.mailboxSendAction.updateMany({
        where: { id: action.id, state: 'dispatching' }, data: { state: 'ready', claimedAt: null },
      })
      await markMailboxNeedsReauthorization(prisma, connection.id, 'The email address or password was not accepted.')
      throw new ConnectedMailError('NEEDS_REAUTHORIZATION')
    }
    await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN')
  }
  try {
    await prisma.mailboxSendAction.update({
      where: { id: action.id }, data: { state: 'sent', sentAt: new Date(), claimedAt: null },
    })
  } catch {
    await prisma.mailboxSendAction.updateMany({
      where: { id: action.id, state: 'dispatching' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new ConnectedMailError('DELIVERY_UNKNOWN')
  }
  return { status: 'sent', actionId: action.id, messageId: action.messageId }
}
