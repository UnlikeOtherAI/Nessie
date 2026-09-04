import type { Prisma, PrismaClient } from '@prisma/client'
import {
  createGmailDraft,
  getGmailDraft,
  updateGmailDraft,
  type GmailDraftContent,
  type OutboundMessage,
} from '@nessie/comms-google'
import { safeFetch } from '@nessie/runtime'
import { getGoogleCapability, type GoogleCapabilityId } from '@nessie/schemas'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
} from './comms-credential-coordinator.js'
import { dispatchClaimedDraft } from './gmail-draft-dispatch.js'
import { fingerprintMessage, fingerprintOf } from './gmail-draft-fingerprint.js'

export { fingerprintDraft } from './gmail-draft-fingerprint.js'

export type GmailDraftErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'SCOPE_MISSING'
  | 'CAPABILITY_BLOCKED'
  | 'NEEDS_REAUTHORIZATION'
  | 'AMBIGUOUS_ACCOUNT'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_CHANGED'
  | 'DRAFT_NOT_SENDABLE'
  | 'DELIVERY_UNKNOWN'
  | 'PROVIDER_FAILED'

export class GmailDraftError extends Error {
  readonly code: GmailDraftErrorCode

  constructor(code: GmailDraftErrorCode, detail?: string) {
    super(`[gmail-draft] ${code.toLowerCase().replaceAll('_', ' ')}${detail ? `: ${detail}` : ''}`)
    this.name = 'GmailDraftError'
    this.code = code
  }
}

const mapCredentialError = (error: unknown): never => {
  if (error instanceof CommsCredentialCoordinatorError) {
    if (error.code === 'CONNECTION_NOT_FOUND' || error.code === 'CREDENTIAL_MISSING') {
      throw new GmailDraftError('GOOGLE_NOT_CONNECTED')
    }
    throw new GmailDraftError(error.code as GmailDraftErrorCode)
  }
  throw error
}

const knownDraftReplay = (
  known: {
    connectionId: string
    contentFingerprint: string
    id: string
    ownerUserId: string
    providerDraftId: string | null
    revision: number
    state: string
  },
  fingerprint: string,
): GmailDraftActionRecord => {
  if (known.contentFingerprint !== fingerprint) throw new GmailDraftError('DRAFT_CHANGED')
  if (known.state === 'draft' && known.providerDraftId) return toRecord(known)
  throw new GmailDraftError('DELIVERY_UNKNOWN')
}

export type GmailDraftDeps = {
  encryptionSecret: string
  fetchImpl?: typeof safeFetch
  now?: () => Date
}

export const gmailFetch = (deps: GmailDraftDeps) => {
  const impl = deps.fetchImpl ?? safeFetch
  return async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const response = await impl(url, init ?? {})
    return {
      body: response.body,
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
      text: () => response.text(),
    }
  }
}

export const loadCredential = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    capabilityId: GoogleCapabilityId
    connectionId?: string
  },
  deps: GmailDraftDeps,
) => {
  try {
    return await loadUserGoogleCommsCredential(prisma, {
      organizationId: input.organizationId,
      userId: input.userId,
      requiredScopes: getGoogleCapability(input.capabilityId).scopes,
      capabilityId: input.capabilityId,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      encryptionSecret: deps.encryptionSecret,
    })
  } catch (error) {
    return mapCredentialError(error)
  }
}

export type ComposeDraftInput = {
  organizationId: string
  userId: string
  connectionId?: string
  message: OutboundMessage
  providerThreadId?: string
  idempotencyKey?: string
}

export type GmailDraftActionRecord = {
  id: string
  providerDraftId: string | null
  revision: number
  state: 'creating' | 'draft' | 'updating' | 'sending' | 'dispatching' | 'delivery_unknown' | 'sent' | 'discarded'
  contentFingerprint: string
  connectionId: string
  ownerUserId: string
}

export const toRecord = (row: {
  id: string
  providerDraftId: string | null
  revision: number
  state: string
  contentFingerprint: string
  connectionId: string
  ownerUserId: string
}): GmailDraftActionRecord => ({
  id: row.id,
  providerDraftId: row.providerDraftId,
  revision: row.revision,
  state: row.state as GmailDraftActionRecord['state'],
  contentFingerprint: row.contentFingerprint,
  connectionId: row.connectionId,
  ownerUserId: row.ownerUserId,
})

export const composeDraftForUser = async (
  prisma: PrismaClient,
  input: ComposeDraftInput,
  deps: GmailDraftDeps,
): Promise<GmailDraftActionRecord> => {
  if (!input.idempotencyKey) throw new GmailDraftError('PROVIDER_FAILED', 'missing idempotency key')
  const credential = await loadCredential(
    prisma,
    { ...input, capabilityId: 'gmail.compose' },
    deps,
  )
  const fingerprint = fingerprintMessage(input.message)
  const known = await prisma.gmailDraftAction.findUnique({
    where: { connectionId_clientRequestId: { connectionId: credential.id, clientRequestId: input.idempotencyKey } },
  })
  // An idempotency key names one exact provider draft. Returning a previous
  // action for changed content would let the UI show new words while Send
  // still targets the old Gmail draft.
  if (known) return knownDraftReplay(known, fingerprint)
  const now = deps.now?.() ?? new Date()
  let action
  try {
    action = await prisma.gmailDraftAction.create({
      data: {
        organizationId: input.organizationId,
        ownerUserId: credential.ownerUserId,
        connectionId: credential.id,
        clientRequestId: input.idempotencyKey,
        providerThreadId: input.providerThreadId ?? null,
        contentFingerprint: fingerprint,
        state: 'creating',
        claimedAt: now,
      },
    })
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'P2002') throw error
    // A concurrent replay won the unique action insert. Re-read its durable
    // state and apply the exact same content/state checks as the fast path.
    const raced = await prisma.gmailDraftAction.findUnique({
      where: {
        connectionId_clientRequestId: {
          connectionId: credential.id,
          clientRequestId: input.idempotencyKey,
        },
      },
    })
    if (!raced) throw new GmailDraftError('DELIVERY_UNKNOWN')
    return knownDraftReplay(raced, fingerprint)
  }
  const fetchImpl = gmailFetch(deps)
  let ref
  try {
    ref = await createGmailDraft(
      fetchImpl,
      credential.credential.accessToken,
      input.message,
      input.providerThreadId,
    )
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: action.id, state: 'creating' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new GmailDraftError('DELIVERY_UNKNOWN', (error as Error).message)
  }
  let row
  try {
    row = await prisma.gmailDraftAction.update({
      where: { id: action.id },
      data: {
        providerDraftId: ref.id,
        providerThreadId: ref.threadId ?? input.providerThreadId ?? null,
        state: 'draft',
        claimedAt: null,
      },
    })
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: action.id, state: 'creating' },
      data: { state: 'delivery_unknown', claimedAt: null },
    })
    throw new GmailDraftError('DELIVERY_UNKNOWN', (error as Error).message)
  }
  return toRecord(row)
}

export const updateDraftForUser = async (
  prisma: PrismaClient,
  input: ComposeDraftInput & { draftActionId: string },
  deps: GmailDraftDeps,
): Promise<GmailDraftActionRecord> => {
  const existing = await prisma.gmailDraftAction.findFirst({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
    },
  })
  if (!existing || existing.state === 'sent' || existing.state === 'discarded') {
    throw new GmailDraftError('DRAFT_NOT_FOUND')
  }
  if (!existing.providerDraftId || existing.state === 'creating' || existing.state === 'delivery_unknown') {
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  if (existing.state !== 'draft') throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  if (input.connectionId && input.connectionId !== existing.connectionId) {
    throw new GmailDraftError('DRAFT_NOT_FOUND')
  }
  const credential = await loadCredential(
    prisma,
    { ...input, connectionId: existing.connectionId, capabilityId: 'gmail.compose' },
    deps,
  )
  // Claim before changing Gmail. Sending also claims `draft` first, so neither
  // operation can validate one provider version and later overwrite the
  // other's durable state.
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'draft' },
    data: { state: 'updating', claimedAt: deps.now?.() ?? new Date() },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  try {
    await updateGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
      input.message,
      existing.providerThreadId ?? undefined,
    )
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'updating' },
      data: { state: 'draft', claimedAt: null },
    })
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const fingerprint = fingerprintMessage(input.message)
  const persisted = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'updating' },
    data: {
      contentFingerprint: fingerprint,
      revision: { increment: 1 },
      state: 'draft',
      claimedAt: null,
    },
  })
  if (persisted.count !== 1) throw new GmailDraftError('DELIVERY_UNKNOWN')
  const row = await prisma.gmailDraftAction.findUniqueOrThrow({ where: { id: existing.id } })
  return toRecord(row)
}

export const readDraftForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; draftActionId: string },
  deps: GmailDraftDeps,
): Promise<GmailDraftContent & { action: GmailDraftActionRecord }> => {
  const existing = await prisma.gmailDraftAction.findFirst({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
    },
  })
  if (!existing) throw new GmailDraftError('DRAFT_NOT_FOUND')
  if (!existing.providerDraftId || existing.state === 'creating' || existing.state === 'delivery_unknown') {
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  const credential = await loadCredential(
    prisma,
    { ...input, connectionId: existing.connectionId, capabilityId: 'gmail.compose' },
    deps,
  )
  let content: Awaited<ReturnType<typeof getGmailDraft>>
  try {
    content = await getGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch (error) {
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  return { ...content, action: toRecord(existing) }
}

export type SendDraftInput = {
  organizationId: string
  userId: string
  draftActionId: string
  connectionId?: string
  expectedFingerprint?: string
  holdMs?: number
}

export type SendDraftResult =
  | { status: 'held'; sendAfter: Date; action: GmailDraftActionRecord }
  | { status: 'sent'; sentMessageId: string; action: GmailDraftActionRecord }

export const sendDraftForUser = async (
  prisma: PrismaClient,
  input: SendDraftInput,
  deps: GmailDraftDeps,
): Promise<SendDraftResult> => {
  const now = deps.now?.() ?? new Date()
  const existing = await prisma.gmailDraftAction.findFirst({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
    },
  })
  if (!existing) throw new GmailDraftError('DRAFT_NOT_FOUND')
  if (input.connectionId && input.connectionId !== existing.connectionId) {
    throw new GmailDraftError('DRAFT_NOT_FOUND')
  }
  if (existing.state === 'creating' || existing.state === 'delivery_unknown' || !existing.providerDraftId) {
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  if (existing.state !== 'draft') throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  const expected = input.expectedFingerprint ?? existing.contentFingerprint
  if (expected !== existing.contentFingerprint) throw new GmailDraftError('DRAFT_CHANGED')

  // Claim before the provider read, not after it. An update must claim the
  // same row before it can mutate Gmail, so the content we validate is the
  // content the ensuing dispatch owns.
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'draft' },
    data: {
      state: 'sending',
      sendAfter: input.holdMs && input.holdMs > 0
        ? new Date(now.getTime() + input.holdMs)
        : null,
    },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')

  let credential
  try {
    credential = await loadCredential(
      prisma,
      {
        organizationId: input.organizationId,
        userId: input.userId,
        connectionId: existing.connectionId,
        capabilityId: 'gmail.compose',
      },
      deps,
    )
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'sending' },
      data: { state: 'draft', sendAfter: null, claimedAt: null },
    })
    throw error
  }

  // Re-read from Gmail, never from our own row: the draft is mutable outside
  // Nessie too, and this is the whole point of the fingerprint.
  let content: Awaited<ReturnType<typeof getGmailDraft>>
  try {
    content = await getGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch (error) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'sending' },
      data: { state: 'draft', sendAfter: null, claimedAt: null },
    })
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const live = fingerprintOf(content)
  if (live !== expected) {
    await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'sending' },
      data: { state: 'draft', sendAfter: null, claimedAt: null },
    })
    throw new GmailDraftError('DRAFT_CHANGED')
  }

  if (input.holdMs && input.holdMs > 0) {
    const held = await prisma.gmailDraftAction.findUniqueOrThrow({
      where: { id: existing.id },
    })
    return {
      status: 'held',
      sendAfter: held.sendAfter ?? new Date(now.getTime() + input.holdMs),
      action: toRecord(held),
    }
  }
  return dispatchClaimedDraft(prisma, existing.id, deps)
}

export {
  dispatchClaimedDraft,
  resolveStaleGmailDispatches,
  resolveStaleGmailDraftUpdates,
  STALE_CLAIM_WINDOW_MS,
} from './gmail-draft-dispatch.js'
export { discardDraftForUser } from './gmail-draft-discard.js'

/** Cancel a held send inside the undo window. */
export const undoHeldSend = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; draftActionId: string },
): Promise<GmailDraftActionRecord> => {
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
      state: 'sending',
    },
    data: { state: 'draft', sendAfter: null, claimedAt: null },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  const row = await prisma.gmailDraftAction.findUniqueOrThrow({
    where: { id: input.draftActionId },
  })
  return toRecord(row)
}

/** Attach the chat message that carries this draft's card. */
export const attachDraftMessage = async (
  prisma: PrismaClient,
  draftActionId: string,
  messageId: string,
): Promise<void> => {
  await prisma.gmailDraftAction.update({
    where: { id: draftActionId },
    data: { messageId },
  })
}

export type { Prisma as GmailDraftPrisma }
