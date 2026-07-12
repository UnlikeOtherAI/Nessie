import type { McpToolResult } from '@nessie/mcp-client'

/**
 * Shared, defensive readers for MCP tool results.
 *
 * Tools return either `structuredContent` or JSON encoded as text content, and
 * a payload may be a bare array or a wrapper object. Both the external-agent
 * history hydration and the DeepSignal Signals surface parse the same shapes, so
 * the coercion lives here once rather than being forked per consumer.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const firstString = (
  record: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []

/** Coerce a tool result into a JS value: structured content, else parsed text. */
export const readToolJson = (result: McpToolResult): unknown => {
  if (result.structuredContent) return result.structuredContent
  const text = result.content
    .flatMap((block) =>
      isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('')
    .trim()
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Pull the list out of a tool payload that may be a bare array or a wrapper. */
export const extractList = (value: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(value)) return value
  if (isRecord(value)) {
    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key] as unknown[]
    }
  }
  return []
}
