import { safeFetch } from '@nessie/runtime'

/**
 * SDK `fetch` option for outbound MCP requests. Validates the target, pins the
 * connection to the validated IP(s), and re-validates + re-pins on every
 * redirect hop (see `safeFetch`). Without it the SDK falls back to the global
 * fetch, which the connector URL — or a 3xx from it — could steer to an
 * internal or metadata address after the guard has already run. Used by both
 * the API probe path and the worker runtime.
 */
export const safeMcpFetch: typeof globalThis.fetch = ((input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? input : input.url
  return safeFetch(url, init ?? undefined)
}) as typeof globalThis.fetch
