import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import type { Attachment, Prisma, PrismaClient } from '@prisma/client'
import {
  FileTooLargeError,
  QuotaExceededError,
  type EncryptionKeyRingInput,
  type FileService,
} from '@nessie/runtime'
import {
  EXECUTOR_RESULT_IMAGE_MAXIMUM,
  EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
  ExecutorImageReferenceSchema,
  ExecutorMcpServerNameSchema,
  sniffExecutorImageMimeType,
  type ExecutorImageMimeType,
  type ExecutorImageReference,
} from '@nessie/schemas'

import { decryptExecutorCommandJson } from './executor-command-codec.js'
import { authorizeExecutorDaemonControlCall } from './executor-daemon.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

/**
 * The images a local program returned, kept as files.
 *
 * The daemon takes each image out of an `mcp.call` result and uploads it on
 * its own signed `attachment` request before the result's receipt
 * (docs/executor-protocol/command-attachments.md). Here the upload becomes an
 * ordinary `FileService` attachment — quota-gated, accounted to the person
 * whose launch the command runs under, metadata-stripped and thumbnailed like
 * any image — linked to its command by `executorCommandId` and the digest the
 * result's reference names.
 *
 * The daemon applies the same caps when it extracts; they are applied again
 * here because the machine key is the only thing vouching for the request.
 * The signature, the command's state and the caps are decided under the
 * executor's connection lock; the bytes are written after it, outside, so a
 * 4 MiB write never stalls that executor's polls and receipts. The caps are
 * checked once more inside the store's own admission transaction, which is
 * what makes them exact when uploads race.
 */

/** A command takes images while its result may still be on its way. */
const ACCEPTING_STATES: ReadonlySet<string> = new Set(['accepted', 'started', 'unknown_outcome'])

/**
 * Images one executor may upload per window, across all its commands. A
 * program answering with screenshots in a loop is at a handful a minute; this
 * bounds what a machine key alone can write. Over it the upload answers 429,
 * which the daemon retries on its next poll rather than giving the image up.
 */
export const EXECUTOR_ATTACHMENT_RATE_WINDOW_MS = 60_000
export const EXECUTOR_ATTACHMENT_RATE_MAXIMUM = 60

const EXTENSIONS: Readonly<Record<ExecutorImageMimeType, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const invalid = (message: string): ExecutorError =>
  new ExecutorError(EXECUTOR_ERROR_CODES.COMMAND_ATTACHMENT_INVALID, message)

const refused = (message: string): ExecutorError =>
  new ExecutorError(EXECUTOR_ERROR_CODES.COMMAND_ATTACHMENT_REFUSED, message)

type KeptImage = { contentByteLength: number | null; contentDigest: string | null }

/** The per-command caps over the images already kept and this one. */
const assertWithinCommandCaps = (kept: readonly KeptImage[], byteLength: number): void => {
  if (kept.length >= EXECUTOR_RESULT_IMAGE_MAXIMUM) {
    throw refused(`A command keeps at most ${EXECUTOR_RESULT_IMAGE_MAXIMUM} images.`)
  }
  const total = kept.reduce((sum, image) => sum + (image.contentByteLength ?? 0), byteLength)
  if (total > EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES) {
    throw refused(`The images of one command are at most ${EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES / 1024 / 1024} MiB together.`)
  }
}

const keptImages = (tx: Prisma.TransactionClient, commandId: string): Promise<KeptImage[]> =>
  tx.attachment.findMany({
    where: { executorCommandId: commandId },
    select: { contentByteLength: true, contentDigest: true },
  })

/** Images this executor's commands kept since `since`. */
const recentExecutorImages = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; organizationId: string; since: Date },
): Promise<number> => {
  const recent = await tx.attachment.groupBy({
    by: ['executorCommandId'],
    where: {
      createdAt: { gt: input.since },
      executorCommandId: { not: null },
      organizationId: input.organizationId,
    },
    _count: { _all: true },
  })
  if (recent.length === 0) return 0
  const own = await tx.executorCommand.findMany({
    where: {
      binding: { executorId: input.executorId },
      id: { in: recent.flatMap((group) => (group.executorCommandId ? [group.executorCommandId] : [])) },
    },
    select: { id: true },
  })
  const ownIds = new Set(own.map((command) => command.id))
  return recent.reduce(
    (sum, group) => sum + (group.executorCommandId && ownIds.has(group.executorCommandId) ? group._count._all : 0),
    0,
  )
}

// Named after the program that answered, when the command still says which:
// `kelpie-screenshot-2.png`. Server names are already lowercase slugs.
const imageFilename = (
  encryptionSecret: EncryptionKeyRingInput,
  command: { deliveryPayloadCiphertext: string | null },
  ordinal: number,
  mimeType: ExecutorImageMimeType,
): string => {
  let server: string | null = null
  if (command.deliveryPayloadCiphertext) {
    try {
      const payload = decryptExecutorCommandJson(encryptionSecret, command.deliveryPayloadCiphertext)
      const args = payload.args as Record<string, unknown> | undefined
      const parsed = ExecutorMcpServerNameSchema.safeParse(args?.server)
      if (parsed.success) server = parsed.data
    } catch {
      // A payload that no longer decrypts only costs the file its prefix.
    }
  }
  return `${server ? `${server}-` : ''}screenshot-${ordinal}.${EXTENSIONS[mimeType]}`
}

/** `ExecutorDaemonCommandAttachmentRequestSchema`, as the route parsed it. */
type AttachmentUpload = {
  attachment: {
    byteLength: number
    commandId: string
    digest: string
    mimeType: ExecutorImageMimeType
    occurredAt: string
  }
  connectionEpoch: string
  dataBase64: string
  executorId: string
  signature: string
}

type AttachmentPlan = {
  agentId: string
  commandId: string
  filename: string
  organizationId: string
  runId: string
  toolCallId: string
  uploaderId: string
}

/**
 * Under the executor lock: the command is this executor's and still takes
 * images, and this one fits. Null when the same image is already kept — a
 * re-upload after a restart, in any state, is the same attachment.
 */
const planExecutorCommandAttachment = async (
  tx: Prisma.TransactionClient,
  encryptionSecret: EncryptionKeyRingInput,
  executorId: string,
  attachment: AttachmentUpload['attachment'],
  now: Date,
): Promise<AttachmentPlan | null> => {
  const command = await tx.executorCommand.findUnique({
    where: { id: attachment.commandId },
    select: {
      binding: { select: { candidateHandleDigest: true, executorId: true } },
      deliveryPayloadCiphertext: true,
      id: true,
      state: true,
      toolCall: {
        select: {
          run: {
            select: { agentId: true, id: true, thread: { select: { channel: { select: { organizationId: true } } } } },
          },
        },
      },
      toolCallId: true,
    },
  })
  if (!command || command.binding.executorId !== executorId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor command is unavailable.')
  }
  const kept = await keptImages(tx, command.id)
  if (kept.some((image) => image.contentDigest === attachment.digest)) return null
  if (!ACCEPTING_STATES.has(command.state)) {
    throw refused('This command no longer takes images.')
  }
  assertWithinCommandCaps(kept, attachment.byteLength)
  const { run } = command.toolCall
  const organizationId = run.thread.channel.organizationId
  const recent = await recentExecutorImages(tx, {
    executorId,
    organizationId,
    since: new Date(now.getTime() - EXECUTOR_ATTACHMENT_RATE_WINDOW_MS),
  })
  if (recent >= EXECUTOR_ATTACHMENT_RATE_MAXIMUM) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_ATTACHMENT_RATE_LIMITED,
      'This executor is uploading images faster than Nessie keeps them; try again shortly.',
    )
  }
  // The person whose launch the command runs under: the binding candidate's
  // actor. The file is theirs for quota and accounting, as a chat upload is.
  const candidate = await tx.executorAvailabilityCandidate.findUnique({
    where: { handleDigest: command.binding.candidateHandleDigest },
    select: { actorUserId: true },
  })
  if (!candidate) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor command provenance is unavailable.')
  }
  return {
    agentId: run.agentId,
    commandId: command.id,
    filename: imageFilename(encryptionSecret, command, kept.length + 1, attachment.mimeType),
    organizationId,
    runId: run.id,
    toolCallId: command.toolCallId,
    uploaderId: candidate.actorUserId,
  }
}

// Raised inside the store's admission transaction when a racing upload of the
// same image won; the caller answers it as recorded.
class ImageAlreadyKept extends Error {}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'

/**
 * `POST /api/executor-daemon/commands/attachment`. Answers the attachment it
 * stored, or null when the image was already kept for the command; either way
 * the daemon hears `{recorded: true}`.
 */
export const recordAuthorizedExecutorCommandAttachment = async (
  prisma: PrismaClient,
  deps: { encryptionSecret: EncryptionKeyRingInput; fileService: FileService },
  input: AttachmentUpload,
  now = new Date(),
): Promise<Attachment | null> => {
  const { attachment } = input
  // The signature covers the digest, not the bytes, so the bytes must be the
  // digest's; and a declared type is only a claim until the magic agrees.
  const bytes = Buffer.from(input.dataBase64, 'base64')
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (bytes.length !== attachment.byteLength || digest !== attachment.digest) {
    throw invalid('The image bytes do not match their signed digest.')
  }
  if (sniffExecutorImageMimeType(bytes) !== attachment.mimeType) {
    throw invalid(`The image bytes are not the ${attachment.mimeType} they declare.`)
  }
  const plan = await authorizeExecutorDaemonControlCall(
    prisma,
    {
      connectionEpoch: input.connectionEpoch,
      executorId: input.executorId,
      observedAt: attachment.occurredAt,
      payload: { attachment, connectionEpoch: input.connectionEpoch, executorId: input.executorId },
      signature: input.signature,
      type: 'attachment',
    },
    (tx) => planExecutorCommandAttachment(tx, deps.encryptionSecret, input.executorId, attachment, now),
    now,
  )
  if (!plan) return null
  try {
    const { attachment: stored } = await deps.fileService.store({
      // Again under the organisation's admission lock, so two racing uploads
      // for one command cannot both pass the caps checked above.
      admit: async (tx) => {
        const current = await keptImages(tx, plan.commandId)
        if (current.some((image) => image.contentDigest === attachment.digest)) throw new ImageAlreadyKept()
        assertWithinCommandCaps(current, attachment.byteLength)
      },
      attribution: {
        actorId: plan.agentId,
        actorType: 'agent',
        agentId: plan.agentId,
        organizationId: plan.organizationId,
        runId: plan.runId,
        systemComponent: 'executor-daemon.attachment',
        toolCallId: plan.toolCallId,
        userId: plan.uploaderId,
      },
      body: Readable.from(bytes),
      executorCommand: {
        contentByteLength: attachment.byteLength,
        contentDigest: attachment.digest,
        id: plan.commandId,
      },
      filename: plan.filename,
      mime: attachment.mimeType,
      organizationId: plan.organizationId,
      uploaderId: plan.uploaderId,
    })
    return stored
  } catch (error) {
    if (error instanceof ImageAlreadyKept || isUniqueViolation(error)) return null
    if (error instanceof QuotaExceededError) throw refused("The organisation's file storage is full.")
    if (error instanceof FileTooLargeError) throw refused('The image is larger than this Nessie accepts.')
    throw error
  }
}

/**
 * The image references a terminal result carries, as the daemon writes them:
 * `image` items of its `content` naming an `attachmentDigest`. One that does
 * not parse is refused rather than skipped, so a result cannot slip a
 * reference past the check below by misspelling it.
 */
export const executorResultImageReferences = (
  result: Record<string, unknown> | undefined,
): ExecutorImageReference[] => {
  if (!result || !Array.isArray(result.content)) return []
  const references: ExecutorImageReference[] = []
  for (const entry of result.content as unknown[]) {
    if (
      !entry || typeof entry !== 'object'
      || (entry as { type?: unknown }).type !== 'image' || !('attachmentDigest' in entry)
    ) continue
    const parsed = ExecutorImageReferenceSchema.safeParse(entry)
    if (!parsed.success) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.COMMAND_RESULT_INVALID,
        'Executor result carries a malformed image reference.',
      )
    }
    references.push(parsed.data)
  }
  return references
}

/**
 * Result intake: every image a terminal result references was uploaded for
 * that command, with the type and size the reference states. Otherwise the
 * result names bytes Nessie does not hold, and it is refused.
 */
export const assertExecutorResultImagesKept = async (
  tx: Prisma.TransactionClient,
  commandId: string,
  result: Record<string, unknown> | undefined,
): Promise<void> => {
  const references = executorResultImageReferences(result)
  if (references.length === 0) return
  const kept = await tx.attachment.findMany({
    where: {
      contentDigest: { in: references.map((reference) => reference.attachmentDigest) },
      executorCommandId: commandId,
    },
    select: { contentByteLength: true, contentDigest: true, mime: true },
  })
  for (const reference of references) {
    const image = kept.find((row) => row.contentDigest === reference.attachmentDigest)
    if (!image || image.mime !== reference.mimeType || image.contentByteLength !== reference.byteLength) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.COMMAND_RESULT_INVALID,
        'Executor result references an image that was not uploaded for its command.',
      )
    }
  }
}
