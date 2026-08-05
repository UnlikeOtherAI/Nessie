import type { AgentModelOption } from '@nessie/schemas'

/**
 * Model names carry versions (`GPT-5.1`, `Kimi K2`, `claude-opus-4-5`), and a
 * plain lexicographic sort buries the newest ones: `GPT-10` lands before
 * `GPT-5`, and `GPT-4.1` before `GPT-5`. So a label is compared as alternating
 * text and version chunks — text ascending, version chunks descending — which
 * keeps families alphabetical while the highest version of each leads.
 */
type LabelChunk =
  | { kind: 'text'; text: string }
  | { kind: 'version'; segments: number[] }

const VERSION_PATTERN = /\d+(?:\.\d+)*/g

const chunkLabel = (label: string): LabelChunk[] => {
  const chunks: LabelChunk[] = []
  let cursor = 0

  for (const match of label.toLowerCase().matchAll(VERSION_PATTERN)) {
    const start = match.index
    if (start > cursor) {
      chunks.push({ kind: 'text', text: label.slice(cursor, start) })
    }
    chunks.push({
      kind: 'version',
      segments: match[0].split('.').map((segment) => Number(segment)),
    })
    cursor = start + match[0].length
  }

  if (cursor < label.length) {
    chunks.push({ kind: 'text', text: label.slice(cursor) })
  }
  return chunks
}

const compareVersions = (left: number[], right: number[]): number => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    // A missing segment is the less specific release: `5` precedes `5.1`, and
    // descending order therefore puts `5.1` first.
    const difference = (right[index] ?? -1) - (left[index] ?? -1)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

const compareChunks = (left: LabelChunk, right: LabelChunk): number => {
  if (left.kind === 'text' && right.kind === 'text') {
    return left.text.localeCompare(right.text)
  }
  if (left.kind === 'version' && right.kind === 'version') {
    return compareVersions(left.segments, right.segments)
  }
  // Mixed chunk kinds only meet where one label ran out of text, e.g. `o3`
  // against `o-mini`; keep plain text ahead of a version so the order is total.
  return left.kind === 'text' ? -1 : 1
}

export const compareModelLabels = (left: string, right: string): number => {
  const leftChunks = chunkLabel(left)
  const rightChunks = chunkLabel(right)
  const shared = Math.min(leftChunks.length, rightChunks.length)

  for (let index = 0; index < shared; index += 1) {
    const difference = compareChunks(leftChunks[index]!, rightChunks[index]!)
    if (difference !== 0) {
      return difference
    }
  }
  // A shared prefix means the shorter label is the base model: `GPT-5` before
  // `GPT-5 mini`.
  return leftChunks.length - rightChunks.length
}

/**
 * Provider first — the picker groups by provider — then newest model first
 * within each provider.
 */
export const compareAgentModelOptions = (
  left: AgentModelOption,
  right: AgentModelOption,
): number =>
  left.providerDisplayName.localeCompare(right.providerDisplayName)
  || compareModelLabels(left.displayName, right.displayName)
  || compareModelLabels(left.model, right.model)
