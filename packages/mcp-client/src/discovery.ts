import type { McpToolDescriptor } from './types.js'

/**
 * In-memory `tools/list` cache. One entry per connection. Time-to-live is
 * configurable (default 5 minutes); refresh is explicit — no background
 * polling — so callers can decide when to invalidate.
 */
export const DEFAULT_DISCOVERY_TTL_MS = 5 * 60 * 1000

type CacheEntry = {
  tools: McpToolDescriptor[]
  fetchedAt: number
}

export class DiscoveryCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(private readonly ttlMs: number = DEFAULT_DISCOVERY_TTL_MS) {}

  get(id: string, now: number = Date.now()): McpToolDescriptor[] | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (now - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(id)
      return null
    }
    return entry.tools
  }

  set(id: string, tools: McpToolDescriptor[], now: number = Date.now()): void {
    this.entries.set(id, { tools, fetchedAt: now })
  }

  invalidate(id: string): void {
    this.entries.delete(id)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Normalise the SDK's `tools/list` response into our `McpToolDescriptor[]`
 * shape. We strip SDK-internal fields and keep only what callers need.
 */
export function normaliseTools(
  raw: { tools: Array<Record<string, unknown>> },
): McpToolDescriptor[] {
  return raw.tools.map((t) => {
    const descriptor: McpToolDescriptor = {
      name: String(t.name),
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
    }
    if (typeof t.title === 'string') descriptor.title = t.title
    if (typeof t.description === 'string') descriptor.description = t.description
    if (t.outputSchema && typeof t.outputSchema === 'object') {
      descriptor.outputSchema = t.outputSchema as Record<string, unknown>
    }
    if (t.annotations && typeof t.annotations === 'object') {
      descriptor.annotations = t.annotations as Record<string, unknown>
    }
    return descriptor
  })
}
