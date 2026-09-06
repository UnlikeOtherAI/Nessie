import { resolveMx, resolveSrv } from 'node:dns/promises'

import type { SafeFetchOptions } from '@nessie/runtime'

/**
 * Everything address-first discovery reaches the outside world with, under one
 * shared deadline.
 *
 * Discovery answers a person who is waiting on a form, so DNS and HTTPS are
 * fanned out together and every leg is bounded by the *same* budget rather than
 * by its own: a domain that answers DNS instantly and then holds an HTTPS body
 * open forever must not be able to spend three seconds per read. The seams here
 * (`dns`, `fetch`, `timeout`) exist so the whole fan-out can be driven in a test
 * without a socket — nothing below this line is allowed to be the only way to
 * reach the network.
 */

/** One budget for the whole fan-out, not one per leg. */
export const DISCOVERY_TIMEOUT_MS = 3_000

/** An autoconfiguration document is a few KiB; anything larger is not one. */
const DISCOVERY_MAX_BYTES = 64 * 1024

export type MxRecord = { exchange: string; priority: number }

export type SrvRecord = { name: string; port: number; priority: number; weight: number }

export type MailboxDiscoveryDns = {
  mx: (domain: string) => Promise<MxRecord[]>
  srv: (name: string) => Promise<SrvRecord[]>
}

export type MailboxDiscoveryFetch = (
  url: URL,
  init: RequestInit,
  options: SafeFetchOptions,
) => Promise<Response>

/** Testable deadline seam; the default gives all generic discovery work one budget. */
export type MailboxDiscoveryTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
) => Promise<T | null>

/** One operation bounded by whatever is left of the request's budget. */
export type WithinDeadline = <T>(operation: Promise<T>) => Promise<T | null>

export const defaultDns: MailboxDiscoveryDns = {
  mx: async (domain) => resolveMx(domain),
  srv: async (name) => resolveSrv(name),
}

export const defaultTimeout: MailboxDiscoveryTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
) => {
  if (timeoutMs <= 0) return null
  return new Promise<T | null>((resolve) => {
    let complete = false
    const finish = (value: T | null): void => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    void operation.then((value) => finish(value)).catch(() => finish(null))
  })
}

export const settled = async <T>(
  operation: Promise<T>,
  timeout: MailboxDiscoveryTimeout,
  timeoutMs: number,
): Promise<T | null> => {
  try {
    return await timeout(operation, timeoutMs)
  } catch {
    return null
  }
}

export const discoveryFetch = async (
  run: MailboxDiscoveryFetch,
  url: URL,
  withinDeadline: WithinDeadline,
): Promise<string | null> => {
  const response = await withinDeadline(run(url, {
    headers: { Accept: 'application/json, application/xml, text/xml;q=0.9' },
    method: 'GET',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }, {
    maxRedirects: 2,
    redirectPolicy: 'same-origin',
  }))
  if (!response || response.status !== 200) return null
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > DISCOVERY_MAX_BYTES) return null
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      // A response can send headers and then hold its body open forever. Keep
      // each read within the same discovery deadline as DNS and connection.
      const next = await withinDeadline(reader.read())
      if (!next) {
        await reader.cancel()
        return null
      }
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > DISCOVERY_MAX_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}
