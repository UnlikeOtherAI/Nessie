import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  EXECUTOR_RESULT_IMAGE_MAXIMUM,
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
  ExecutorCommandIdSchema,
  type ExecutorCommandEnvelope,
  type ExecutorImageMimeType,
  type ExecutorImageReference,
} from '@nessie/schemas'

import { ExecutorApiError } from './api-client.js'
import type { ExecutorCommandRecoveryStore } from './command-recovery.js'
import {
  executorMcpImageReferences,
  withdrawExecutorMcpImage,
  type ExecutorMcpImage,
} from './mcp-images.js'
import { assertOrdinaryDirectory, missing } from './sandbox-layout.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'

/**
 * A result's images between the call that returned them and the receipt that
 * reports it.
 *
 * The bytes are written as raw sidecars
 * `<runtimeDir>/attachments/<commandId>/<sha256 hex>.bin` while the command
 * executes, so they are on disk, fsynced, before the `result_pending` journal
 * entry that references them is saved. Before the receipt, each referenced
 * image is uploaded on its own signed request; a restart between an upload and
 * the receipt uploads again, which the control plane accepts as the same
 * attachment. An acknowledged receipt removes its command's sidecars, and the
 * daemon's start removes every command's but the journal's current one.
 */

const ATTACHMENTS_DIRECTORY = 'attachments'

export type ExecutorCommandAttachmentStore = {
  /** The kept bytes of one image, or null when they are missing or no longer match their digest. */
  read: (commandId: string, digest: string) => Promise<Buffer | null>
  remove: (commandId: string) => Promise<void>
  /** Removes every command's sidecars except `keepCommandId`'s. */
  sweep: (keepCommandId: string | undefined) => Promise<void>
  write: (commandId: string, images: readonly ExecutorMcpImage[]) => Promise<void>
}

const sidecarName = (digest: string): string => {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1]
  if (!hex) throw new Error('An attachment digest names no sidecar.')
  return `${hex}.bin`
}

const digestOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/**
 * One store secures the runtime directory once, as the recovery journal's
 * does: on Windows that proof spawns the packaged native helper, and the store
 * is touched on every command. The sidecar folders beneath it are created
 * owner-only the way the sandboxes' are.
 */
export const createExecutorCommandAttachmentStore = (
  stateDir: string,
  deps: { ensureRuntimeDirectory?: (stateDir: string) => Promise<string> } = {},
): ExecutorCommandAttachmentStore => {
  const ensureRuntimeDirectory = deps.ensureRuntimeDirectory ?? ensureExecutorRuntimeDirectory
  let secured: Promise<string> | undefined
  const root = async (): Promise<string> => {
    secured ??= ensureRuntimeDirectory(stateDir)
    try {
      return resolve(await secured, ATTACHMENTS_DIRECTORY)
    } catch (error) {
      secured = undefined
      throw error
    }
  }
  // A command id is a UUID by schema, which is what makes it a safe name.
  const commandDirectory = async (commandId: string): Promise<string> =>
    resolve(await root(), ExecutorCommandIdSchema.parse(commandId))

  return {
    read: async (commandId, digest) => {
      const path = resolve(await commandDirectory(commandId), sidecarName(digest))
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.size > EXECUTOR_RESULT_IMAGE_MAX_BYTES) return null
        const bytes = await readFile(path)
        return digestOf(bytes) === digest ? bytes : null
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    remove: async (commandId) => {
      await rm(await commandDirectory(commandId), { force: true, recursive: true })
    },
    sweep: async (keepCommandId) => {
      const directory = await root()
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      await Promise.all(entries
        .filter((entry) => entry !== keepCommandId)
        .map((entry) => rm(resolve(directory, entry), { force: true, recursive: true })))
    },
    write: async (commandId, images) => {
      const directory = await commandDirectory(commandId)
      await mkdir(directory, { mode: 0o700, recursive: true })
      await assertOrdinaryDirectory(directory, 'The executor attachment directory is unavailable.')
      for (const image of images) {
        const handle = await open(resolve(directory, sidecarName(image.digest)), 'w', 0o600)
        try {
          await handle.writeFile(image.bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    },
  }
}

/**
 * At daemon start, every sidecar folder but the one the journal still names
 * is a leftover of a command that already ended. A journal that cannot be read
 * removes nothing: which folder is current is exactly what it cannot say.
 */
export const sweepExecutorCommandAttachments = async (
  journal: Pick<ExecutorCommandRecoveryStore, 'load'>,
  sidecars: Pick<ExecutorCommandAttachmentStore, 'sweep'>,
): Promise<void> => {
  const current = await journal.load()
  await sidecars.sweep(current?.command.commandId)
}

/**
 * How long one upload may take. Each gets a floor and its share of the bytes,
 * so all of one result's uploads together — at most six images and 8 MiB —
 * fit inside `EXECUTOR_MCP_UPLOAD_BUDGET_MS`, which the command's expiry
 * reserves for them. A timeout is not a refusal: the next poll uploads again.
 */
export const executorAttachmentUploadTimeoutMs = (byteLength: number): number => Math.floor(
  EXECUTOR_MCP_UPLOAD_BUDGET_MS / 2 / EXECUTOR_RESULT_IMAGE_MAXIMUM
  + ((EXECUTOR_MCP_UPLOAD_BUDGET_MS / 2) * Math.min(byteLength, EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES))
    / EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
)

export type ExecutorAttachmentUpload = (image: {
  bytes: Buffer
  commandId: ExecutorCommandEnvelope['commandId']
  digest: string
  mimeType: ExecutorImageMimeType
}) => Promise<void>

// A fenced or stale connection and a rate limit are not a refusal of the
// image: the receipt behind the upload fails the same way until the daemon
// reconnects or waits, and the next poll retries both.
const NOT_A_REFUSAL_CODES = new Set(['EXECUTOR_CONNECTION_FENCED', 'EXECUTOR_HEARTBEAT_STALE'])

const uploadWasRefused = (error: unknown): error is ExecutorApiError => (
  error instanceof ExecutorApiError
  && error.status !== undefined
  && error.status >= 400
  && error.status < 500
  && error.status !== 408
  && error.status !== 429
  && !NOT_A_REFUSAL_CODES.has(error.code ?? '')
)

const MAX_REASON_LENGTH = 200

const refusalReason = (error: ExecutorApiError): string => {
  const message = error.message.replace(/\s+/g, ' ').trim()
  const bounded = message.length <= MAX_REASON_LENGTH ? message : `${message.slice(0, MAX_REASON_LENGTH - 1)}…`
  return `Nessie refused it (${bounded})`
}

/**
 * Uploads every image `result` references, and answers the result its receipt
 * must carry. A refusal (a 4xx) is terminal: that image is withdrawn — its
 * reference and markers become `[image unavailable: <reason>]` — and the
 * rewritten result is journaled before anything else is sent, so the refused
 * upload is never made again and the receipt's digest is computed from what
 * was journaled. A sidecar that is gone or no longer matches is withdrawn the
 * same way. Anything else — a timeout, a 5xx, a lost connection — throws,
 * and the next poll delivers again from the same journal.
 */
export const deliverExecutorCommandAttachments = async (input: {
  command: ExecutorCommandEnvelope
  journal: (result: Record<string, unknown>) => Promise<void>
  onWithdrawn?: (reference: ExecutorImageReference, reason: string) => void
  result: Record<string, unknown>
  sidecars: Pick<ExecutorCommandAttachmentStore, 'read'>
  upload: ExecutorAttachmentUpload
}): Promise<Record<string, unknown>> => {
  let result = input.result
  for (const reference of executorMcpImageReferences(input.result)) {
    const bytes = await input.sidecars.read(input.command.commandId, reference.attachmentDigest)
    let reason: string | undefined
    if (!bytes) {
      reason = 'the image was lost on this machine before it could be delivered'
    } else {
      try {
        await input.upload({
          bytes,
          commandId: input.command.commandId,
          digest: reference.attachmentDigest,
          mimeType: reference.mimeType,
        })
      } catch (error) {
        if (!uploadWasRefused(error)) throw error
        reason = refusalReason(error)
      }
    }
    if (reason === undefined) continue
    input.onWithdrawn?.(reference, reason)
    result = withdrawExecutorMcpImage(result, reference.attachmentDigest, reason)
    await input.journal(result)
  }
  return result
}
