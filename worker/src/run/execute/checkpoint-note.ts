import type { ProviderMessage } from '@nessie/runtime'
import { projectMailToolResultsForUtilityTranscript } from '../mail-tool-transcript.js'
import type { CheckpointSource } from './checkpoint.js'

// The checkpoint note is produced by ONE bounded model call made from the
// budget headroom the loop reserved (spec §3). It must therefore be cheap,
// structured, and degrade to something mechanical rather than failing the stop.

const TRANSCRIPT_MESSAGES = 24
const TRANSCRIPT_TOOL_OUTPUT_CHARS = 1_200
const MECHANICAL_NOTE_CHARS = 4_000

const SOURCES_HEADING = /^##\s*sources\s*$/i

const renderTranscript = (messages: ProviderMessage[]): string =>
  projectMailToolResultsForUtilityTranscript(messages)
    .slice(-TRANSCRIPT_MESSAGES)
    .map((message) => {
      if (message.role === 'tool') {
        return `[tool result]\n${message.content.slice(0, TRANSCRIPT_TOOL_OUTPUT_CHARS)}`
      }
      if (message.role === 'assistant') {
        const called = message.toolCalls?.length
          ? `\n[called: ${message.toolCalls.map((tc) => tc.toolName).join(', ')}]`
          : ''
        return `[assistant]\n${message.content ?? ''}${called}`
      }
      return `[${message.role}]\n${message.content}`
    })
    .join('\n\n')

export const buildCheckpointNotePrompt = (input: {
  goal: string
  messages: ProviderMessage[]
}): string =>
  [
    'This agent run is stopping at a limit before the work is finished. Write the',
    'handover note the next run will start from. It is the ONLY thing that',
    'survives — anything you leave out has to be re-discovered and re-paid for.',
    '',
    'Output exactly these two sections and nothing else:',
    '',
    '## State',
    '- What was being worked on and what has already been established (exact',
    '  names, numbers, and values from tool output — no paraphrase).',
    '- What has been ruled out, and what is still open.',
    '- The single most useful next step.',
    '',
    '## Sources',
    '- One line per source: the URL COPIED VERBATIM, then " — " and a short label.',
    '- Never shorten, normalize, guess, or invent a URL. If none, write "none".',
    '',
    'No preamble, no apology, no meta commentary.',
    '',
    `Original request: ${input.goal.slice(0, 1_000)}`,
    '',
    'Transcript:',
    renderTranscript(input.messages),
  ].join('\n')

const extractUrls = (line: string): string[] =>
  line.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []

/**
 * Split the model's own structured output into narrative + verbatim sources.
 * This parses a format we asked for; it never interprets user intent.
 */
export const parseCheckpointNote = (raw: string): {
  note: string
  sources: CheckpointSource[]
} => {
  const lines = raw.trim().split('\n')
  const headingIndex = lines.findIndex((line) => SOURCES_HEADING.test(line.trim()))
  const sourceLines = headingIndex >= 0 ? lines.slice(headingIndex + 1) : []

  const seen = new Set<string>()
  const sources: CheckpointSource[] = []
  for (const line of sourceLines) {
    for (const url of extractUrls(line)) {
      if (seen.has(url)) continue
      seen.add(url)
      const rest = line.slice(line.indexOf(url) + url.length)
      const title = rest.replace(/^[\s—–-]+/, '').trim()
      sources.push(title ? { title, url } : { url })
    }
  }

  return { note: raw.trim(), sources }
}

/**
 * Fallback when the note call fails or returns nothing: the run's own last
 * assistant text is still real work state, and losing it entirely is worse
 * than saving an unstructured note.
 */
export const mechanicalCheckpointNote = (input: {
  goal: string
  lastAssistantText: string
}): { note: string; sources: CheckpointSource[] } => {
  const body = input.lastAssistantText.trim()
  return {
    note: [
      '## State',
      `Original request: ${input.goal.slice(0, 1_000)}`,
      body
        ? `Last progress reported by the run:\n${body.slice(0, MECHANICAL_NOTE_CHARS)}`
        : 'The run stopped before reporting any progress.',
      '',
      '## Sources',
      'none',
    ].join('\n'),
    sources: [],
  }
}
