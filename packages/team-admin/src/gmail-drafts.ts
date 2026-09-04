import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  canonicalDraftFingerprintInput,
  createGmailDraft,
  deleteGmailDraft,
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

export const fingerprintDraft = (input: {
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  body: string
  attachmentIds?: readonly string[]
}): string =>
  createHash('sha256')
    .update(canonicalDraftFingerprintInput(input))
    .digest('hex')

const fingerprintOf = (draft: GmailDraftContent): string =>
  fingerprintDraft({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    attachmentIds: draft.attachments.map((a) => `${a.filename}:${a.sizeBytes}`),
  })

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
  idempotencyKey: string
}

export type GmailDraftActionRecord = {
  id: string
  providerDraftId: string | null
  revision: number
  state: 'creating' | 'draft' | 'sending' | 'dispatching' | 'delivery_unknown' | 'sent' | 'discarded'
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
  const credential = await loadCredential(
    prisma,
    { ...input, capabilityId: 'gmail.compose' },
    deps,
  )
  const fingerprint = fingerprintDraft({
    to: input.message.to,
    cc: input.message.cc,
    bcc: input.message.bcc,
    subject: input.message.subject,
    body: input.message.body,
    attachmentIds: (input.message.attachments ?? []).map(
      (a) => `${a.filename}:${a.content.byteLength}`,
    ),
  })
  const known = await prisma.gmailDraftAction.findUnique({
    where: { connectionId_clientRequestId: { connectionId: credential.id, clientRequestId: input.idempotencyKey } },
  })
  if (known) {
    if (known.state === 'draft' && known.providerDraftId) return toRecord(known)
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  const now = deps.now?.() ?? new Date()
  const action = await prisma.gmailDraftAction.create({
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
  if (input.connectionId && input.connectionId !== existing.connectionId) {
    throw new GmailDraftError('DRAFT_NOT_FOUND')
  }
  const credential = await loadCredential(
    prisma,
    { ...input, connectionId: existing.connectionId, capabilityId: 'gmail.compose' },
    deps,
  )
  try {
    await updateGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
      input.message,
      existing.providerThreadId ?? undefined,
    )
  } catch (error) {
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const fingerprint = fingerprintDraft({
    to: input.message.to,
    cc: input.message.cc,
    bcc: input.message.bcc,
    subject: input.message.subject,
    body: input.message.body,
  })
  const row = await prisma.gmailDraftAction.update({
    where: { id: existing.id },
    data: {
      contentFingerprint: fingerprint,
      revision: { increment: 1 },
      state: 'draft',
      claimedAt: null,
    },
  })
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
  let content: GmailDraftContent
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

  const credential = await loadCredential(
    prisma,
    {
      organizationId: input.organizationId,
      userId: input.userId,
      connectionId: existing.connectionId,
      capabilityId: 'gmail.compose',
    },
    deps,
  )

  // Re-read from Gmail, never from our own row: the draft is mutable outside
  // Nessie too, and this is the whole point of the fingerprint.
  let content: GmailDraftContent
  try {
    content = await getGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch (error) {
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const live = fingerprintOf(content)
  const expected = input.expectedFingerprint ?? existing.contentFingerprint
  if (live !== expected) {
    throw new GmailDraftError('DRAFT_CHANGED')
  }

  // One winner: whoever flips draft → sending owns the dispatch.
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'draft' },
    data: {
      state: 'sending',
      contentFingerprint: live,
      sendAfter: input.holdMs && input.holdMs > 0
        ? new Date(now.getTime() + input.holdMs)
        : null,
    },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')

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

export { dispatchClaimedDraft, resolveStaleGmailDispatches, STALE_CLAIM_WINDOW_MS } from './gmail-draft-dispatch.js'

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

export const discardDraftForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; draftActionId: string },
  deps: GmailDraftDeps,
): Promise<GmailDraftActionRecord> => {
  const existing = await prisma.gmailDraftAction.findFirst({
    where: {
      id: input.draftActionId,
      organizationId: input.organizationId,
      ownerUserId: input.userId,
    },
  })
  if (!existing) throw new GmailDraftError('DRAFT_NOT_FOUND')
  if (existing.state === 'sent') throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  if (!existing.providerDraftId || existing.state === 'creating' || existing.state === 'delivery_unknown') {
    throw new GmailDraftError('DELIVERY_UNKNOWN')
  }
  const credential = await loadCredential(
    prisma,
    {
      organizationId: input.organizationId,
      userId: input.userId,
      connectionId: existing.connectionId,
      capabilityId: 'gmail.compose',
    },
    deps,
  )
  try {
    await deleteGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch {
    // A draft already gone at Google is still discarded here.
  }
  const row = await prisma.gmailDraftAction.update({
    where: { id: existing.id },
    data: { state: 'discarded', sendAfter: null, claimedAt: null },
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
