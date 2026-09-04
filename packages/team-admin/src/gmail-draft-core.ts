import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  canonicalDraftFingerprintInput,
  type GmailDraftAttachmentIdentity,
  type GmailDraftContent,
} from '@nessie/comms-google'
import { safeFetch } from '@nessie/runtime'
import { getGoogleCapability, type GoogleCapabilityId } from '@nessie/schemas'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
} from './comms-credential-coordinator.js'

export type GmailDraftErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'SCOPE_MISSING'
  | 'CAPABILITY_BLOCKED'
  | 'NEEDS_REAUTHORIZATION'
  | 'AMBIGUOUS_ACCOUNT'
  | 'DRAFT_NOT_FOUND'
  /** The draft changed since it was approved or rendered. */
  | 'DRAFT_CHANGED'
  /** Another send already claimed this draft. */
  | 'DRAFT_NOT_SENDABLE'
  /** A server-minted judged-grant fact no longer matches live authority. */
  | 'JUDGED_AUTHORIZATION_INVALID'
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
  attachmentIdentities?: readonly GmailDraftAttachmentIdentity[]
}): string =>
  createHash('sha256')
    .update(canonicalDraftFingerprintInput(input))
    .digest('hex')

export const fingerprintOf = (draft: GmailDraftContent): string =>
  fingerprintDraft({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    attachmentIdentities: draft.attachments,
  })

/** Injected so tests need no network; production uses the pinned fetch. */
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

export const loadDraftCredential = async (
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

export type GmailDraftActionRecord = {
  id: string
  providerDraftId: string
  revision: number
  state: 'draft' | 'sending' | 'sent' | 'discarded'
  contentFingerprint: string
  connectionId: string
  ownerUserId: string
}

export const toGmailDraftRecord = (row: {
  id: string
  providerDraftId: string
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
