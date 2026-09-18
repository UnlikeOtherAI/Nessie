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

/** `bytes <start>-<end>/<total>` — the total is the only field worth trusting here. */
export const parseContentRangeTotal = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(header.trim())
  if (!match?.[1]) return undefined
  const total = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(total) && total > 0 ? total : undefined
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
    const headers: Record<string, string> = {}
    if (partial !== undefined && partial.bytes < file.bytes) {
      headers.Range = `bytes=${partial.bytes}-`
      // Without this a rotated object would be spliced onto our prefix and the
      // digest check would be the only thing that noticed, megabytes later.
      if (metadata.etag !== undefined) headers['If-Match'] = metadata.etag
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
      const total = parseContentRangeTotal(response.headers.get('content-range'))
      if (total !== file.bytes) return { ok: false, reason: 'size_mismatch' }
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
