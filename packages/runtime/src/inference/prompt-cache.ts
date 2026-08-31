import { createHash } from 'node:crypto'
import type { ProviderMessage, ToolSchemaDescriptor } from './types.js'

// Stable cache key from the request's cacheable prefix: model + tool set + the
// leading system anchor. Only the anchor is hashed — it is the byte-stable
// block callers put first (persona, instructions, structural facts), while
// every volatile per-run line (clock, memory context, checkpoint notes) rides
// in later messages — so the key is identical across runs of the same agent
// and the provider routes them to the same prompt cache. Derived from content,
// so it needs no agent/run id threaded in.
export const buildPromptCacheKey = (
  model: string,
  baseMessages: ProviderMessage[],
  tools: ToolSchemaDescriptor[] | undefined,
): string | undefined => {
  const anchor = baseMessages[0]
  if (!anchor) return undefined
  const toolNames = (tools ?? []).map((tool) => tool.toolName).sort().join(',')
  return createHash('sha256')
    .update(`${model}\u0000${toolNames}\u0000${JSON.stringify(anchor)}`)
    .digest('hex')
    .slice(0, 40)
}
