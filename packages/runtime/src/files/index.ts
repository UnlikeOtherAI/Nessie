import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import type { Attachment, PrismaClient } from '@prisma/client'

import { type BudgetScope, checkStorageQuota, type StorageQuotaDecision } from '../budget.js'
import {
  currentStorageUsageBytes,
  type LedgerAttribution,
  recordStorageStored,
  type StorageUsageScope,
} from '../ledger.js'
import type { Storage } from '../storage/index.js'

/**
 * The single chokepoint for blob file work. Everything that stores, streams,
 * or deletes a file goes through here so storage I/O, the Attachment table, and
 * the stored-bytes usage ledger stay in lockstep. Never call `storage.*` or
 * `prisma.attachment` for file bytes from anywhere else — usage accounting is
 * part of the file operation, not optional.
 *
 * Knowledge-base ROW creation (a KnowledgePage of kind=file plus its version)
 * stays in the knowledge provider; this service only owns the bytes those rows
 * point at. KB-aware scope is derived from the linked page so per-space/team
 * usage nets to zero on delete.
 */

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly usedBytes: bigint,
    readonly limitBytes: bigint | null,
  ) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

export class FileTooLargeError extends Error {
  constructor(
    readonly bytesWritten: number,
    readonly maxBytes: number,
  ) {
    super(`File exceeds the ${maxBytes}-byte upload limit (${bytesWritten} bytes)`)
    this.name = 'FileTooLargeError'
  }
}

// Derive a coarse attachment `kind` from the MIME type for cheap UI branching
// (inline preview vs. download) without re-parsing MIME everywhere.
export const kindFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

export type FileScope = {
  projectId?: string | null
  teamId?: string | null
  spaceId?: string | null
}

export type StoreFileInput = {
  attribution: LedgerAttribution
  organizationId: string
  uploaderId: string | null
  filename: string
  mime: string
  body: Readable
  scope?: FileScope
  messageId?: string | null
  knowledgePageId?: string | null
  width?: number | null
  height?: number | null
  abortSignal?: AbortSignal
}

export type FileService = {
  store(input: StoreFileInput): Promise<{ attachment: Attachment; bytesWritten: number }>
  openStream(
    attachmentId: string,
    organizationId: string,
  ): Promise<{ stream: Readable; attachment: Attachment } | null>
  delete(
    attachmentId: string,
    organizationId: string,
    attribution: LedgerAttribution,
    scope?: FileScope,
  ): Promise<boolean>
  checkQuota(scope: BudgetScope, addBytes: number | bigint): Promise<StorageQuotaDecision>
  currentUsage(scope: BudgetScope): Promise<{ usedBytes: bigint; limitBytes: bigint | null }>
  usageForScope(scope: StorageUsageScope): Promise<bigint>
}

export const createFileService = (deps: {
  prisma: PrismaClient
  storage: Storage
  maxUploadBytes: number
}): FileService => {
  const { prisma, storage, maxUploadBytes } = deps

  const budgetScope = (organizationId: string, scope?: FileScope): BudgetScope => ({
    organizationId,
    projectId: scope?.projectId ?? null,
    teamId: scope?.teamId ?? null,
  })

  // For delete accounting we must mirror the scope the store event used so the
  // per-space/team SUM nets to zero. If the attachment is a KB page attachment,
  // derive the scope from its page; otherwise fall back to org-only.
  const deriveScope = async (
    attachment: Attachment,
    override?: FileScope,
  ): Promise<StorageUsageScope> => {
    if (override) {
      return {
        organizationId: attachment.organizationId,
        projectId: override.projectId ?? null,
        teamId: override.teamId ?? null,
        spaceId: override.spaceId ?? null,
        uploaderId: attachment.uploaderId,
      }
    }
    if (attachment.knowledgePageId) {
      const page = await prisma.knowledgePage.findUnique({
        where: { id: attachment.knowledgePageId },
        select: { projectId: true, teamId: true, spaceId: true },
      })
      if (page) {
        return {
          organizationId: attachment.organizationId,
          projectId: page.projectId,
          teamId: page.teamId,
          spaceId: page.spaceId,
          uploaderId: attachment.uploaderId,
        }
      }
    }
    return { organizationId: attachment.organizationId, uploaderId: attachment.uploaderId }
  }

  const store: FileService['store'] = async (input) => {
    const scope = budgetScope(input.organizationId, input.scope)
    // Advisory pre-check: rejects when already over the cap before we read bytes.
    const pre = await checkStorageQuota(prisma, scope, 0)
    if (!pre.allowed) {
      throw new QuotaExceededError(pre.reason, pre.usedBytes, pre.limitBytes)
    }

    const storageKey = `${input.organizationId}/${randomUUID()}`
    let bytesWritten: number
    try {
      const result = await storage.putStream(storageKey, input.body, {
        mime: input.mime,
        abortSignal: input.abortSignal,
      })
      bytesWritten = result.bytesWritten
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined)
      throw error
    }

    if (bytesWritten > maxUploadBytes) {
      await storage.delete(storageKey).catch(() => undefined)
      throw new FileTooLargeError(bytesWritten, maxUploadBytes)
    }

    // Authoritative quota re-check now that the exact size is known.
    const post = await checkStorageQuota(prisma, scope, bytesWritten)
    if (!post.allowed) {
      await storage.delete(storageKey).catch(() => undefined)
      throw new QuotaExceededError(post.reason, post.usedBytes, post.limitBytes)
    }

    let attachment: Attachment
    try {
      attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          uploaderId: input.uploaderId,
          messageId: input.messageId ?? null,
          knowledgePageId: input.knowledgePageId ?? null,
          kind: kindFromMime(input.mime),
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(bytesWritten),
          storageKey,
          width: input.width ?? null,
          height: input.height ?? null,
        },
      })
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined)
      throw error
    }

    await recordStorageStored(prisma, {
      attribution: input.attribution,
      scope: {
        organizationId: input.organizationId,
        projectId: input.scope?.projectId ?? null,
        teamId: input.scope?.teamId ?? null,
        spaceId: input.scope?.spaceId ?? null,
        uploaderId: input.uploaderId,
      },
      deltaBytes: bytesWritten,
      operation: 'store',
      attachmentId: attachment.id,
    })

    return { attachment, bytesWritten }
  }

  const openStream: FileService['openStream'] = async (attachmentId, organizationId) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!attachment || attachment.organizationId !== organizationId) {
      return null
    }
    const stream = await storage.getStream(attachment.storageKey)
    if (!stream) {
      return null
    }
    return { stream, attachment }
  }

  const deleteFile: FileService['delete'] = async (
    attachmentId,
    organizationId,
    attribution,
    scope,
  ) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!attachment || attachment.organizationId !== organizationId) {
      return false
    }
    const usageScope = await deriveScope(attachment, scope)
    // Delete the row first so a re-delete is a clean no-op, then the object
    // (best-effort — a missing object is harmless), then the negative delta.
    await prisma.attachment.delete({ where: { id: attachment.id } })
    await storage.delete(attachment.storageKey).catch(() => undefined)
    await recordStorageStored(prisma, {
      attribution,
      scope: usageScope,
      deltaBytes: -Number(attachment.sizeBytes),
      operation: 'delete',
      attachmentId: attachment.id,
    })
    return true
  }

  return {
    store,
    openStream,
    delete: deleteFile,
    checkQuota: (scope, addBytes) => checkStorageQuota(prisma, scope, addBytes),
    currentUsage: async (scope) => {
      const decision = await checkStorageQuota(prisma, scope, 0)
      return { usedBytes: decision.usedBytes, limitBytes: decision.limitBytes }
    },
    usageForScope: (scope) => currentStorageUsageBytes(prisma, scope),
  }
}
