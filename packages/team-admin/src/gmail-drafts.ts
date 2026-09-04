import type { Prisma, PrismaClient } from '@prisma/client'
import {
  createGmailDraft,
  getGmailDraft,
  updateGmailDraft,
  type GmailDraftContent,
} from '@nessie/comms-google'
import { safeFetch } from '@nessie/runtime'
import { getGoogleCapability, type GoogleCapabilityId } from '@nessie/schemas'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
} from './comms-credential-coordinator.js'
import { dispatchClaimedDraft } from './gmail-draft-dispatch.js'
import { fingerprintMessage, fingerprintOf } from './gmail-draft-fingerprint.js'
import {
  toRecord,
  type ComposeDraftInput,
  type GmailDraftActionRecord,
  type SendDraftInput,
  type SendDraftResult,
} from './gmail-draft-record.js'
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
    providerThreadId: string | null
    revision: number
    sendAfter: Date | null
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
  const known = await prisma.gmailDraftAction.findUnique({
    where: { connectionId_clientRequestId: { connectionId: credential.id, clientRequestId: input.idempotencyKey } },
  })
  // An idempotency key names one exact provider draft, never new visible words.
  if (known) {
    return knownDraftReplay(
      known,
      fingerprintMessage(input.message, known.providerThreadId ?? input.providerThreadId),
    )
  }
  const fingerprint = fingerprintMessage(input.message, input.providerThreadId)
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
    return knownDraftReplay(
      raced,
      fingerprintMessage(input.message, raced.providerThreadId ?? input.providerThreadId),
    )
  }
  const fetchImpl = gmailFetch(deps)
  let ref: Awaited<ReturnType<typeof createGmailDraft>>
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
  const providerThreadId = ref.threadId ?? input.providerThreadId ?? null
  let row
  try {
    row = await prisma.gmailDraftAction.update({
      where: { id: action.id },
      data: {
        providerDraftId: ref.id,
        providerThreadId,
        contentFingerprint: fingerprintMessage(input.message, providerThreadId ?? undefined),
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
  const claimedAt = deps.now?.() ?? new Date()
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'draft' },
    data: { state: 'updating', claimedAt },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  let ref: Awaited<ReturnType<typeof updateGmailDraft>>
  let live: Awaited<ReturnType<typeof getGmailDraft>>
  try {
    live = await getGmailDraft(
      gmailFetch(deps), credential.credential.accessToken, existing.providerDraftId,
    )
    if (!live.editable) {
      throw new GmailDraftError('DRAFT_NOT_SENDABLE', 'edit this draft in Gmail')
    }
  } catch (error) {
    // This was only a read/shape validation. No provider mutation has begun,
    // so an owned claim can safely be made editable again.
    await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'updating', claimedAt },
      data: { state: 'draft', claimedAt: null },
    })
    if (error instanceof GmailDraftError) throw error
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  try {
    // This is the provider mutation boundary. Do not ever recover this claim:
    // a timed-out PUT can still have changed Gmail after this process dies.
    const mutationClaimed = await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'updating', claimedAt },
      data: { state: 'update_unknown' },
    })
    if (mutationClaimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
    ref = await updateGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
      {
        ...input.message,
        ...(live.inReplyTo ? { inReplyTo: live.inReplyTo } : {}),
        ...(live.references.length > 0 ? { references: live.references } : {}),
      },
      existing.providerThreadId ?? undefined,
    )
  } catch {
    // The provider call either began or we cannot prove it did not. Keep the
    // row locked rather than allowing an ABA edit to overwrite unknown Gmail
    // bytes. This is deliberately distinct from delivery_unknown.
    throw new GmailDraftError('DRAFT_NOT_SENDABLE', 'draft update is unconfirmed; inspect it in Gmail')
  }
  const providerThreadId = ref.threadId ?? existing.providerThreadId
  const fingerprint = fingerprintMessage({
    ...input.message,
    ...(live.inReplyTo ? { inReplyTo: live.inReplyTo } : {}),
    ...(live.references.length > 0 ? { references: live.references } : {}),
  }, providerThreadId ?? undefined)
  const persisted = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'update_unknown', claimedAt },
    data: {
      contentFingerprint: fingerprint,
      providerThreadId,
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

  // Claim before reading Gmail so validation owns the dispatched content.
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'draft' },
    data: {
      state: 'sending',
      // A validating send is not yet dispatchable. Recovery treats its stale
      // claim as a draft because it has not crossed the provider send boundary.
      sendAfter: null,
      claimedAt: now,
    },
  })
  if (claimed.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  const releaseValidation = () => prisma.gmailDraftAction.updateMany({
    where: { id: existing.id, state: 'sending', sendAfter: null, claimedAt: now },
    data: { state: 'draft', sendAfter: null, claimedAt: null },
  })

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
    await releaseValidation()
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
    await releaseValidation()
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  if (!content.editable) {
    await releaseValidation()
    throw new GmailDraftError('DRAFT_NOT_SENDABLE', 'edit this unsupported draft in Gmail')
  }
  const live = fingerprintOf(content)
  if (live !== expected) {
    await releaseValidation()
    throw new GmailDraftError('DRAFT_CHANGED')
  }

  if (input.holdMs && input.holdMs > 0) {
    const sendAfter = new Date((deps.now?.() ?? new Date()).getTime() + input.holdMs)
    const published = await prisma.gmailDraftAction.updateMany({
      where: { id: existing.id, state: 'sending', sendAfter: null, claimedAt: now },
      data: { sendAfter, claimedAt: null },
    })
    if (published.count !== 1) throw new GmailDraftError('DRAFT_NOT_SENDABLE')
    const held = await prisma.gmailDraftAction.findUniqueOrThrow({
      where: { id: existing.id },
    })
    return {
      status: 'held',
      sendAfter: held.sendAfter ?? sendAfter,
      action: toRecord(held),
    }
  }
  return dispatchClaimedDraft(prisma, existing.id, deps, now)
}

export {
  dispatchClaimedDraft,
  resolveStaleGmailDispatches,
  resolveStaleGmailDraftValidations,
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
export type {
  ComposeDraftInput,
  GmailDraftActionRecord,
  SendDraftInput,
  SendDraftResult,
} from './gmail-draft-record.js'
