import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { safeFetch } from '@nessie/runtime'
import type { LocalModelFile } from '@nessie/schemas'
import { localModelFileUrl } from '@nessie/schemas'

/**
 * Fetching the bytes of a local model, with the digest as the only thing that
 * decides whether they are the right bytes.
 *
 * The pin is `file.sha256`, which came from the catalogue compiled into this
 * binary — not from the server, not from a manifest in the bucket, and not
 * from the response. A URL here is only how the bytes are asked for; if what
 * comes back hashes to anything else, it is discarded and the failure is
 * terminal rather than retried into a loop.
 *
 * Ollama hashes the file independently when it is imported, so a corrupted
 * download has to get past two checks that were computed in different
 * processes from different code. That is the half of Kelpie's model story
 * this replaces: its catalogue shipped `sha256: ''`, a hash nobody had.
 */

/** Ollama's import copies the blob, so a shared volume needs the file twice over, plus headroom. */
const DISK_HEADROOM_FACTOR = 2.2

/** Enough for a redirect onto the CDN edge and no more; weights carry no credentials. */
const MAX_REDIRECTS = 2

const LOCK_FILE = '.downloading'

export type WeightsFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>

const defaultWeightsFetch: WeightsFetch = (url, init) =>
  safeFetch(url, init, { maxRedirects: MAX_REDIRECTS })

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes: number
}

export type DownloadFailureReason =
  /** The object is not the length the catalogue pinned — a different build behind the same URL. */
  | 'size_mismatch'
  /** The bytes arrived whole and hashed to something else. Terminal. */
  | 'digest_mismatch'
  /** Not enough room for the file and Ollama's copy of it. */
  | 'no_storage'
  /** Another process on this machine holds the lock for this file. */
  | 'download_in_progress'
  /** The mirror could not be reached, or answered something unusable. */
  | 'mirror_unreachable'

export type DownloadOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: DownloadFailureReason; observedDigest?: string; detail?: string }

export const localModelsDirectory = (stateDir: string): string => resolve(stateDir, 'local-models')

/** One directory per catalogue entry; the digest names the file inside it. */
export const stagedFilePath = (stateDir: string, entryId: string, file: LocalModelFile): string =>
  resolve(localModelsDirectory(stateDir), entryId, `${file.sha256}.part`)

export const verifiedFilePath = (stateDir: string, entryId: string, file: LocalModelFile): string =>
  resolve(localModelsDirectory(stateDir), entryId, `${file.sha256}.gguf`)

type ResumeMetadata = { etag?: string }

const metadataPath = (partPath: string): string => `${partPath}.meta`

const readResumeMetadata = async (partPath: string): Promise<ResumeMetadata> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath(partPath), 'utf8'))
    const etag = (parsed as { etag?: unknown } | null)?.etag
    return typeof etag === 'string' && etag.length > 0 ? { etag } : {}
  } catch {
    return {}
  }
}

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Hold the lock, or say who does.
 *
 * A download that died leaves its lock behind; a download still running must
 * not have its `.part` written by a second process. Liveness of the recorded
 * pid is what tells those apart, exactly as Kelpie's downloader does.
 */
const acquireLock = async (lockPath: string): Promise<boolean> => {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, payload, { flag: 'wx' })
      return true
    } catch {
      let holder: number | undefined
      try {
        const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
        const pid = (parsed as { pid?: unknown } | null)?.pid
        holder = typeof pid === 'number' ? pid : undefined
      } catch {
        holder = undefined
      }
      if (holder !== undefined && isPidAlive(holder)) return false
      await rm(lockPath, { force: true })
    }
  }
  return false
}

/** Hash what is already on disk, so a resumed download continues one digest rather than starting a second. */
const hashPartialFile = async (
  path: string,
): Promise<{ bytes: number; hash: ReturnType<typeof createHash> } | undefined> => {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return undefined
  }
  if (size === 0) return undefined
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, rejectHash) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash())
      .on('error', rejectHash)
  })
  return { bytes: size, hash }
}

/**
 * `bytes <start>-<end>/<total>`.
 *
 * The start matters as much as the total: a mirror that answers `206` from
 * offset zero to a request that asked for byte 2 000 000 000 would otherwise
 * have its body written at our offset, producing a file that is garbage in a
 * way only the final digest notices — gigabytes later.
 */
export const parseContentRange = (
  header: string | null,
): { start: number; total: number } | undefined => {
  if (header === null) return undefined
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim())
  if (!match?.[1] || !match[3]) return undefined
  const start = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(start) || start < 0) return undefined
  return Number.isSafeInteger(total) && total > 0 ? { start, total } : undefined
}

export const hasRoomFor = async (
  directory: string,
  bytes: number,
  probe: (path: string) => Promise<{ bavail: number; bsize: number }> = statfs,
): Promise<{ ok: true } | { ok: false; availableBytes: number; requiredBytes: number }> => {
  const required = Math.ceil(bytes * DISK_HEADROOM_FACTOR)
  try {
    const stats = await probe(directory)
    const available = stats.bavail * stats.bsize
    return available >= required ? { ok: true } : { ok: false, availableBytes: available, requiredBytes: required }
  } catch {
    // A volume that will not answer `statfs` is not a reason to refuse a
    // download — the write itself will fail loudly enough if it is full.
    return { ok: true }
  }
}

export type DownloadOptions = {
  baseUrl: string
  entryId: string
  file: LocalModelFile
  stateDir: string
  fetchImpl?: WeightsFetch
  onProgress?: (progress: DownloadProgress) => void
  statfsImpl?: (path: string) => Promise<{ bavail: number; bsize: number }>
}

export const downloadModelFile = async (options: DownloadOptions): Promise<DownloadOutcome> => {
  const { baseUrl, entryId, file, stateDir } = options
  const fetchImpl = options.fetchImpl ?? defaultWeightsFetch
  const finalPath = verifiedFilePath(stateDir, entryId, file)
  const partPath = stagedFilePath(stateDir, entryId, file)

  // Already here, and it only got its final name after its digest matched.
  try {
    if ((await stat(finalPath)).size === file.bytes) return { ok: true, path: finalPath }
  } catch {
    // Not downloaded yet; carry on.
  }

  await mkdir(dirname(partPath), { recursive: true, mode: 0o700 })

  const room = await hasRoomFor(dirname(partPath), file.bytes, options.statfsImpl)
  if (!room.ok) {
    return {
      ok: false,
      reason: 'no_storage',
      detail: `needs ${room.requiredBytes} bytes, ${room.availableBytes} free`,
    }
  }

  const lockPath = resolve(dirname(partPath), LOCK_FILE)
  if (!(await acquireLock(lockPath))) return { ok: false, reason: 'download_in_progress' }

  try {
    const partial = await hashPartialFile(partPath)
    const metadata = partial === undefined ? {} : await readResumeMetadata(partPath)

    // A `.part` that is already the full length means we died between the last
    // write and the digest check. We have just hashed it, so the answer is in
    // hand — finishing it costs nothing, where re-downloading costs gigabytes.
    if (partial !== undefined && partial.bytes === file.bytes) {
      const completed = partial.hash.digest('hex')
      if (completed === file.sha256) {
        await rename(partPath, finalPath)
        await rm(metadataPath(partPath), { force: true })
        return { ok: true, path: finalPath }
      }
      await rm(partPath, { force: true })
      await rm(metadataPath(partPath), { force: true })
      return { ok: false, reason: 'digest_mismatch', observedDigest: completed }
    }

    const headers: Record<string, string> = {}
    const wantsResume = partial !== undefined && partial.bytes < file.bytes
    if (wantsResume && partial !== undefined) {
      headers.Range = `bytes=${partial.bytes}-`
      // `If-Range`, not `If-Match`. If the object moved, `If-Match` answers 412
      // forever: the partial is kept, every retry re-sends the same stale
      // validator, and the failure reads as a network problem. `If-Range`
      // degrades to a plain 200 of the current object, which the restart path
      // below already handles, so a rotated mirror self-heals in one attempt.
      if (metadata.etag !== undefined) headers['If-Range'] = metadata.etag
    }

    let response: Response
    try {
      response = await fetchImpl(localModelFileUrl(file, baseUrl), { headers })
    } catch (error) {
      return {
        ok: false,
        reason: 'mirror_unreachable',
        detail: error instanceof Error ? error.message : 'request failed',
      }
    }

    if (response.status !== 200 && response.status !== 206) {
      return { ok: false, reason: 'mirror_unreachable', detail: `HTTP ${response.status}` }
    }

    // A 206 must be a slice of the object the catalogue pinned. A 200 means the
    // mirror ignored the range (or the ETag moved), so the prefix on disk is
    // not ours and the hash starts again from nothing.
    let resuming = false
    if (response.status === 206) {
      // A 206 we did not ask for has no prefix to continue, so there is no
      // offset it could be correct at.
      if (!wantsResume || partial === undefined) return { ok: false, reason: 'size_mismatch' }
      const range = parseContentRange(response.headers.get('content-range'))
      if (range === undefined || range.total !== file.bytes) {
        return { ok: false, reason: 'size_mismatch' }
      }
      if (range.start !== partial.bytes) return { ok: false, reason: 'size_mismatch' }
      // A cache edge that served the range without honouring `If-Range` would
      // splice a different object onto our prefix. Comparing the validator we
      // were given costs nothing and catches it before the transfer, rather
      // than at the digest check several gigabytes later.
      const servedEtag = response.headers.get('etag')
      if (metadata.etag !== undefined && servedEtag !== null && servedEtag !== metadata.etag) {
        return { ok: false, reason: 'size_mismatch' }
      }
      resuming = true
    } else {
      const declared = response.headers.get('content-length')
      if (declared !== null && Number.parseInt(declared, 10) !== file.bytes) {
        return { ok: false, reason: 'size_mismatch' }
      }
    }

    const hash = resuming && partial !== undefined ? partial.hash : createHash('sha256')
    let written = resuming && partial !== undefined ? partial.bytes : 0

    const etag = response.headers.get('etag')
    if (etag !== null && !resuming) {
      await writeFile(metadataPath(partPath), JSON.stringify({ etag }), { mode: 0o600 })
    }

    try {
      const handle = await open(partPath, resuming ? 'r+' : 'w', 0o600)
      try {
        if (resuming) await handle.truncate(written)
        const body = response.body
        if (body === null) return { ok: false, reason: 'mirror_unreachable', detail: 'empty body' }
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          if (written + chunk.byteLength > file.bytes) return { ok: false, reason: 'size_mismatch' }
          await handle.write(chunk, 0, chunk.byteLength, written)
          hash.update(chunk)
          written += chunk.byteLength
          options.onProgress?.({ downloadedBytes: written, totalBytes: file.bytes })
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      // A volume that fills mid-stream, or a connection that drops, is an
      // outcome like any other: every other failure here is reported rather
      // than thrown, and a caller that has to catch for only these two would
      // forget. The `.part` survives, so the next attempt resumes.
      const code = (error as NodeJS.ErrnoException | null)?.code
      return code === 'ENOSPC'
        ? { ok: false, reason: 'no_storage', detail: 'the volume filled during the transfer' }
        : {
            ok: false,
            reason: 'mirror_unreachable',
            detail: error instanceof Error ? error.message : 'transfer failed',
          }
    }

    if (written !== file.bytes) return { ok: false, reason: 'size_mismatch' }

    const observedDigest = hash.digest('hex')
    if (observedDigest !== file.sha256) {
      // Terminal, and the partial goes with it: keeping it would resume a
      // download whose prefix we already know to be wrong.
      await rm(partPath, { force: true })
      await rm(metadataPath(partPath), { force: true })
      return { ok: false, reason: 'digest_mismatch', observedDigest }
    }

    await rename(partPath, finalPath)
    await rm(metadataPath(partPath), { force: true })
    return { ok: true, path: finalPath }
  } finally {
    await rm(lockPath, { force: true })
  }
}
