import type { Prisma, PrismaClient } from '@prisma/client'
import {
  createGmailDraft,
  deleteGmailDraft,
  getGmailDraft,
  sendGmailDraft,
  updateGmailDraft,
  type GmailDraftContent,
  type OutboundMessage,
} from '@nessie/comms-google'
import {
  GmailDraftError,
  fingerprintOf,
  gmailFetch,
  loadDraftCredential,
  toGmailDraftRecord,
  type GmailDraftActionRecord,
  type GmailDraftDeps,
} from './gmail-draft-core.js'
import { claimJudgedGmailDraft } from './gmail-draft-judged-claim.js'
import type { JudgedGmailDraftAuthorization } from './send-authorization.js'

export {
  GmailDraftError,
  fingerprintDraft,
  type GmailDraftActionRecord,
  type GmailDraftDeps,
  type GmailDraftErrorCode,
} from './gmail-draft-core.js'
export { claimJudgedGmailDraft } from './gmail-draft-judged-claim.js'

/**
 * The one place a Gmail draft is written, read, or sent.
 *
 * Both callers go through here — the API route behind the card's Send button
 * and the worker tool an agent invokes — because `api/src/services/*` is
 * unreachable from the worker and duplicating the bookkeeping would fork the
 * state claim, the fingerprint check, and the audit trail on day one. This is
 * the route-mirroring rule applied to a provider write.
 */


export type ComposeDraftInput = {
  organizationId: string
  userId: string
  connectionId?: string
  message: OutboundMessage
  /** Reply into an existing Gmail thread. */
  providerThreadId?: string
}

/** Create a real Gmail draft and the durable projection that tracks it. */
export const composeDraftForUser = async (
  prisma: PrismaClient,
  input: ComposeDraftInput,
  deps: GmailDraftDeps,
): Promise<GmailDraftActionRecord> => {
  const credential = await loadDraftCredential(
    prisma,
    { ...input, capabilityId: 'gmail.compose' },
    deps,
  )
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
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }

  let content: GmailDraftContent
  try {
    content = await getGmailDraft(
      fetchImpl,
      credential.credential.accessToken,
      ref.id,
    )
  } catch (error) {
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const fingerprint = fingerprintOf(content)

  const row = await prisma.gmailDraftAction.upsert({
    where: {
      connectionId_providerDraftId: {
        connectionId: credential.id,
        providerDraftId: ref.id,
      },
    },
    create: {
      organizationId: input.organizationId,
      ownerUserId: credential.ownerUserId,
      connectionId: credential.id,
      providerDraftId: ref.id,
      providerThreadId: ref.threadId ?? input.providerThreadId ?? null,
      contentFingerprint: fingerprint,
    },
    update: {
      contentFingerprint: fingerprint,
      revision: { increment: 1 },
      state: 'draft',
    },
  })
  return toGmailDraftRecord(row)
}

/** Replace a draft's content. Any edit invalidates a live approval by design. */
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
  const credential = await loadDraftCredential(
    prisma,
    { ...input, connectionId: existing.connectionId, capabilityId: 'gmail.compose' },
    deps,
  )
  let content: GmailDraftContent
  try {
    await updateGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
      input.message,
      existing.providerThreadId ?? undefined,
    )
    content = await getGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      existing.providerDraftId,
    )
  } catch (error) {
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const fingerprint = fingerprintOf(content)
  const row = await prisma.gmailDraftAction.update({
    where: { id: existing.id },
    data: {
      contentFingerprint: fingerprint,
      revision: { increment: 1 },
      state: 'draft',
      claimedAt: null,
    },
  })
  return toGmailDraftRecord(row)
}

/** The draft as the card renders it. Owner-scoped by the caller's ids. */
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
  const credential = await loadDraftCredential(
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
  return { ...content, action: toGmailDraftRecord(existing) }
}

export type SendDraftInput = {
  organizationId: string
  userId: string
  draftActionId: string
  /**
   * The fingerprint the approver (or the person clicking Send) actually saw.
   * When present the send refuses on mismatch — this is what stops an approved
   * send delivering content that changed afterwards. Omitted only where the
   * caller has no prior view, which today means nothing.
   */
  expectedFingerprint?: string
  /** Hold the dispatch this long so the card can offer Undo. */
  holdMs?: number
  /**
   * A server-minted judgement. Unlike ordinary approval and `always` consent,
   * this must remain live in the same statement that claims the draft.
   */
  judgedAuthorization?: JudgedGmailDraftAuthorization
}

export type SendDraftResult =
  | { status: 'held'; sendAfter: Date; action: GmailDraftActionRecord }
  | { status: 'sent'; sentMessageId: string; action: GmailDraftActionRecord }

/**
 * Send a draft, or hold it for the undo window.
 *
 * Order matters: re-read the live draft, compare the fingerprint, THEN claim
 * the state transition. Claiming first would let a refused send leave the row
 * stuck in `sending`.
 */
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
  if (existing.state !== 'draft') throw new GmailDraftError('DRAFT_NOT_SENDABLE')

  const credential = await loadDraftCredential(
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

  // One winner: whoever flips draft → sending owns the dispatch. Judged
  // consent uses a stricter claim that locks and verifies the exact grant and
  // connection in the same SQL transition; a re-read would leave revoke races.
  if (input.judgedAuthorization) {
    const claimed = await claimJudgedGmailDraft(prisma, {
      authorization: input.judgedAuthorization,
      contentFingerprint: live,
      draftActionId: existing.id,
    })
    if (!claimed) throw new GmailDraftError('JUDGED_AUTHORIZATION_INVALID')
  } else {
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
  }

  if (input.holdMs && input.holdMs > 0) {
    const held = await prisma.gmailDraftAction.findUniqueOrThrow({
      where: { id: existing.id },
    })
    return {
      status: 'held',
      sendAfter: held.sendAfter ?? new Date(now.getTime() + input.holdMs),
      action: toGmailDraftRecord(held),
    }
  }
  return dispatchClaimedDraft(prisma, existing.id, deps)
}

/**
 * A row still `dispatching` this long after its claim means the worker that
 * claimed it died mid-send, and the sweep may claim it again.
 *
 * Two minutes, because the normal `dispatching` window is one Gmail API round
 * trip — a few seconds — and two minutes also covers a worker killed during a
 * slow deploy overlap. The undo window is only seconds, so by the time a sweep
 * could even see the row its `sendAfter` has already elapsed. The failure mode
 * this guards is a reclaimed send whose dead claimer actually reached Gmail
 * before dying; the odds are far better than stranding the draft forever, but
 * they are not zero.
 */
export const STALE_CLAIM_WINDOW_MS = 2 * 60 * 1000

/**
 * Dispatch a draft the caller believes is ready to send.
 *
 * The claim is the first thing this function does: an atomic conditional
 * update flips `sending → dispatching` and stamps `claimedAt`, and only the
 * caller that wins it proceeds. Anything before the flip — a `findUnique`
 * plus a state check — is read-then-check, and with two worker replicas
 * ticking the same sweep both pass it and both call Gmail, so the recipient
 * gets the email twice. Irreversible. The conditional update is the ONLY
 * gate, and it also admits a stale `dispatching` row whose `claimedAt` has
 * passed {@link STALE_CLAIM_WINDOW_MS}, so a worker that died mid-send does
 * not strand the draft.
 */
export const dispatchClaimedDraft = async (
  prisma: PrismaClient,
  draftActionId: string,
  deps: GmailDraftDeps,
): Promise<SendDraftResult> => {
  const now = deps.now?.() ?? new Date()
  const claimed = await prisma.gmailDraftAction.updateMany({
    where: {
      id: draftActionId,
      OR: [
        { state: 'sending' },
        {
          state: 'dispatching',
          claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_WINDOW_MS) },
        },
      ],
    },
    data: { state: 'dispatching', claimedAt: now },
  })
  if (claimed.count !== 1) {
    // The loser is never an error: another dispatcher owns the row, or it was
    // already sent/undone — either way this caller must no-op, NOT send.
    throw new GmailDraftError('DRAFT_NOT_SENDABLE')
  }
  const row = await prisma.gmailDraftAction.findUniqueOrThrow({
    where: { id: draftActionId },
  })
  const credential = await loadDraftCredential(
    prisma,
    {
      organizationId: row.organizationId,
      userId: row.ownerUserId,
      connectionId: row.connectionId,
      capabilityId: 'gmail.compose',
    },
    deps,
  )
  let sent
  try {
    sent = await sendGmailDraft(
      gmailFetch(deps),
      credential.credential.accessToken,
      row.providerDraftId,
    )
  } catch (error) {
    // Return the row to `draft` so the person can retry or edit; leaving it in
    // `dispatching` would strand the draft with no affordance. The condition
    // matches the claim above, so this only clears a claim this caller holds.
    await prisma.gmailDraftAction.updateMany({
      where: { id: row.id, state: 'dispatching' },
      data: { state: 'draft', sendAfter: null, claimedAt: null },
    })
    throw new GmailDraftError('PROVIDER_FAILED', (error as Error).message)
  }
  const updated = await prisma.gmailDraftAction.update({
    where: { id: row.id },
    data: {
      state: 'sent',
      sentAt: now,
      sentMessageId: sent.messageId,
      sendAfter: null,
      claimedAt: null,
    },
  })
  return { status: 'sent', sentMessageId: sent.messageId, action: toGmailDraftRecord(updated) }
}

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
  return toGmailDraftRecord(row)
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
  const credential = await loadDraftCredential(
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
  return toGmailDraftRecord(row)
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
