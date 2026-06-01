/**
 * src/llm/reasoning-tag-stripper.ts — Strip inline reasoning tags from streamed LLM content.
 *
 * Some providers (DeepSeek, Qwen, certain OpenAI-compatible endpoints) emit reasoning
 * inside <thinking>, <thought>, <reasoning>, or <antml:thinking> tags within the
 * regular content field. This module partitions text chunks into reasoning and visible
 * content, tracking tag state across SSE chunks so split tags are handled correctly.
 */

export type PartitionResult = {
  reasoning?: string
  content?: string
}

export type ReasoningState = {
  inReasoning: boolean
  buffer: string
}

// Tag variants we recognise. Opening tags start reasoning; closing tags end it.
const OPEN_TAGS = [
  '<thinking>',
  '<antml:thinking>',
  '<thought>',
  '<reasoning>',
]

const CLOSE_TAGS = [
  '</thinking>',
  '</antml:thinking>',
  '</thought>',
  '</reasoning>',
]

/**
 * Partition a text chunk into reasoning and visible content.
 * Tracks reasoning depth across chunks (tags may span multiple SSE chunks).
 *
 * @param text  The new chunk of text from the stream.
 * @param state Mutable state tracking whether we are inside a reasoning block
 *              and any buffered partial tag from the previous chunk.
 * @returns Partitioned result and updated state.
 */
export function partitionReasoningTags(
  text: string,
  state: ReasoningState,
): { result: PartitionResult; newState: ReasoningState } {
  // Prepend any buffered partial tag from the previous chunk.
  const input = state.buffer + text
  let inReasoning = state.inReasoning
  let buffer = ''

  let reasoningParts: string[] = []
  let contentParts: string[] = []
  let current = ''

  // Simple fence detection: if the entire input (plus buffer) is inside a
  // markdown code block, preserve it as-is. This is a best-effort check that
  // looks for an odd number of triple-backtick sequences before any tag.
  if (isInsideCodeFence(input)) {
    if (inReasoning) {
      reasoningParts.push(input)
    } else {
      contentParts.push(input)
    }
    return {
      result: buildResult(reasoningParts, contentParts),
      newState: { inReasoning, buffer: '' },
    }
  }

  let i = 0
  while (i < input.length) {
    // Look for the next '<' that could start a tag.
    const lt = input.indexOf('<', i)
    if (lt === -1) {
      // No more tags — rest is plain text.
      current += input.slice(i)
      break
    }

    // Text before the potential tag goes to the current accumulator.
    current += input.slice(i, lt)
    i = lt

    // Try to match an opening or closing tag at position i.
    const matchedOpen = matchTagAt(input, i, OPEN_TAGS)
    const matchedClose = matchTagAt(input, i, CLOSE_TAGS)

    if (matchedOpen) {
      // Flush current accumulator to the appropriate bucket.
      flushCurrent(current, inReasoning, reasoningParts, contentParts)
      current = ''
      inReasoning = true
      i += matchedOpen.length
    } else if (matchedClose) {
      flushCurrent(current, inReasoning, reasoningParts, contentParts)
      current = ''
      inReasoning = false
      i += matchedClose.length
    } else {
      // Not a recognised tag. Check if this '<' could be the start of a tag
      // that is split across chunks — we buffer up to the next '>' or the
      // end of the input.
      const gt = input.indexOf('>', i)
      if (gt === -1) {
        // No closing '>' in this chunk — buffer the rest for the next chunk.
        buffer = input.slice(i)
        // Everything before this potential tag is current text.
        // current already includes text up to '<' via the slice above.
        // But we need to include the '<' itself if we decide it's not a tag.
        // Actually, current already has text up to lt. The '<' and after is buffered.
        // So we break here.
        i = input.length // break loop
      } else {
        // There is a '>' but it doesn't form a recognised tag. Treat as plain text.
        current += input.slice(i, gt + 1)
        i = gt + 1
      }
    }
  }

  // Flush any remaining current text.
  if (current) {
    flushCurrent(current, inReasoning, reasoningParts, contentParts)
  }

  return {
    result: buildResult(reasoningParts, contentParts),
    newState: { inReasoning, buffer },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchTagAt(input: string, pos: number, tags: string[]): string | null {
  for (const tag of tags) {
    if (input.startsWith(tag, pos)) {
      return tag
    }
  }
  return null
}

function flushCurrent(
  text: string,
  inReasoning: boolean,
  reasoningParts: string[],
  contentParts: string[],
): void {
  if (text.length === 0) return
  if (inReasoning) {
    reasoningParts.push(text)
  } else {
    contentParts.push(text)
  }
}

function buildResult(
  reasoningParts: string[],
  contentParts: string[],
): PartitionResult {
  const result: PartitionResult = {}
  if (reasoningParts.length > 0) {
    result.reasoning = reasoningParts.join('')
  }
  if (contentParts.length > 0) {
    result.content = contentParts.join('')
  }
  return result
}

/**
 * Best-effort check: if the input appears to be inside a markdown code fence,
 * preserve tags as plain text. We look for an odd number of triple-backtick
 * sequences before the first reasoning tag. If none, we check the whole string.
 */
function isInsideCodeFence(input: string): boolean {
  // Find the first occurrence of any reasoning tag.
  let firstTagIndex = Infinity
  for (const tag of [...OPEN_TAGS, ...CLOSE_TAGS]) {
    const idx = input.indexOf(tag)
    if (idx !== -1 && idx < firstTagIndex) {
      firstTagIndex = idx
    }
  }

  const searchEnd = firstTagIndex === Infinity ? input.length : firstTagIndex
  const prefix = input.slice(0, searchEnd)

  // Count triple-backtick sequences.
  const fenceRe = /```/g
  let count = 0
  while (fenceRe.exec(prefix) !== null) {
    count++
  }

  return count % 2 === 1
}
