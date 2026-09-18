import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

/**
 * The executor's side of Ollama: detect it, and import a verified GGUF into it.
 *
 * Nessie does not ship an inference engine. It ships bytes and a pin, and asks
 * the Ollama the person installed to hold them under a namespaced model name.
 * That keeps the engine, its GPU story and its update cadence somebody else's
 * problem, and it means a person can see and delete what we put on their disk
 * with the tool they already use.
 *
 * **Why this file talks to a loopback origin directly.** Everything else in
 * `executor/src` dials through `@nessie/runtime`'s pinned transport, which
 * refuses private and loopback addresses by design — that is what makes it an
 * SSRF boundary. Ollama is a loopback service, so the pinned transport cannot
 * express this call at all. The origin is not caller-influenced: it is a
 * compiled default that only the reviewed local policy may change, never the
 * server and never a delegation. This is the same admission
 * `cli/src/local.ts` already holds for localhost health polling.
 */

/** Where Ollama listens unless the reviewed policy says otherwise. */
export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434'

/**
 * The floor is the release whose `/api/create` takes a `files` map of blob
 * digests. Below it the import path below does not exist.
 */
export const MINIMUM_OLLAMA_VERSION = '0.34.0'

/** A blob push streams gigabytes; the rest of these calls are small and quick. */
const CONTROL_TIMEOUT_MS = 10_000
const IMPORT_TIMEOUT_MS = 30 * 60_000

/** A JSON document, or the GGUF itself as a stream. Nothing else is ever sent. */
type OllamaRequestBody = string | NodeReadableStream

export type OllamaFetch = (
  url: string,
  init: {
    body?: OllamaRequestBody
    duplex?: 'half'
    headers?: Record<string, string>
    method?: string
    signal?: AbortSignal
  },
) => Promise<Response>

const defaultOllamaFetch: OllamaFetch = (url, init) =>
  fetch(url, init as RequestInit & { duplex?: 'half' })

/** `0.34.1` against `0.34.0`, numerically and per segment; a version we cannot read is not a version that passes. */
export const meetsVersionFloor = (observed: string, floor: string): boolean => {
  const parse = (value: string): number[] | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
  }
  const left = parse(observed)
  const right = parse(floor)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

export type OllamaPresence =
  | { available: false; reason: 'unreachable' }
  | { available: false; reason: 'too_old'; version: string }
  | { available: true; version: string }

export const detectOllama = async (
  origin: string = DEFAULT_OLLAMA_ORIGIN,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<OllamaPresence> => {
  try {
    const response = await fetchImpl(`${origin}/api/version`, {
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    if (!response.ok) return { available: false, reason: 'unreachable' }
    const body: unknown = await response.json()
    const version = (body as { version?: unknown } | null)?.version
    if (typeof version !== 'string') return { available: false, reason: 'unreachable' }
    return meetsVersionFloor(version, MINIMUM_OLLAMA_VERSION)
      ? { available: true, version }
      : { available: false, reason: 'too_old', version }
  } catch {
    return { available: false, reason: 'unreachable' }
  }
}

export type ImportFailureReason =
  /** Ollama hashed the body and got something other than the digest in the URL. */
  | 'digest_rejected'
  /** The model was assembled but does not report the blob we pinned. */
  | 'digest_unconfirmed'
  | 'unreachable'

export type ImportOutcome = { ok: true } | { ok: false; reason: ImportFailureReason; detail?: string }

/** Ollama answers 404 for a digest it does not hold, which is how a re-import skips the upload. */
export const blobExists = async (
  origin: string,
  digest: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<boolean> => {
  try {
    const response = await fetchImpl(`${origin}/api/blobs/sha256:${digest}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * Hand Ollama the file, with the digest in the URL.
 *
 * This is the second of the two independent checks: our own streamed hash said
 * these bytes are the pin, and now a different process hashes them again and
 * answers `400` if it disagrees. A corrupted file has to defeat both.
 */
export const pushBlob = async (
  origin: string,
  digest: string,
  path: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<ImportOutcome> => {
  try {
    const response = await fetchImpl(`${origin}/api/blobs/sha256:${digest}`, {
      method: 'POST',
      body: Readable.toWeb(createReadStream(path)),
      duplex: 'half',
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    })
    if (response.status === 400) return { ok: false, reason: 'digest_rejected' }
    if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'blob upload failed',
    }
  }
}

export const createModel = async (
  origin: string,
  modelName: string,
  files: Record<string, string>,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<ImportOutcome> => {
  try {
    const response = await fetchImpl(`${origin}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName, files, stream: false }),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'create failed',
    }
  }
}

/**
 * Every digest the created model reports holding.
 *
 * `/api/show` is the only way to ask Ollama what it actually assembled, as
 * opposed to what we asked it to assemble. A model whose blobs do not include
 * our pin is not the model we pinned, whatever it is called.
 */
export const showModelDigests = async (
  origin: string,
  modelName: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<string[] | undefined> => {
  try {
    const response = await fetchImpl(`${origin}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    const found = new Set<string>()
    const walk = (value: unknown, depth: number): void => {
      if (depth > 6) return
      if (typeof value === 'string') {
        const match = /^sha256[:-]([0-9a-f]{64})$/.exec(value)
        if (match?.[1]) found.add(match[1])
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1)
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) walk(item, depth + 1)
      }
    }
    walk(body, 0)
    return [...found]
  } catch {
    return undefined
  }
}

export type ImportRequest = {
  digest: string
  fileName: string
  modelName: string
  origin?: string
  path: string
  fetchImpl?: OllamaFetch
}

/**
 * Push, assemble, and only then believe it.
 *
 * The confirmation step is what makes the pin mean something end to end: the
 * model is advertised as ready only after Ollama itself reports holding the
 * digest the catalogue named.
 */
export const importVerifiedModel = async (request: ImportRequest): Promise<ImportOutcome> => {
  const origin = request.origin ?? DEFAULT_OLLAMA_ORIGIN
  const fetchImpl = request.fetchImpl ?? defaultOllamaFetch

  if (!(await blobExists(origin, request.digest, fetchImpl))) {
    const pushed = await pushBlob(origin, request.digest, request.path, fetchImpl)
    if (!pushed.ok) return pushed
  }

  const created = await createModel(
    origin,
    request.modelName,
    { [request.fileName]: `sha256:${request.digest}` },
    fetchImpl,
  )
  if (!created.ok) return created

  const digests = await showModelDigests(origin, request.modelName, fetchImpl)
  if (digests === undefined) {
    return { ok: false, reason: 'digest_unconfirmed', detail: 'show returned nothing readable' }
  }
  if (!digests.includes(request.digest)) {
    return { ok: false, reason: 'digest_unconfirmed', detail: 'created model does not hold the pinned blob' }
  }
  return { ok: true }
}
