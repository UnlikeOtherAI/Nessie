import type { PathRewriter } from './path-rewrite.js'
import type { CodingPermissionDenial } from './types.js'

/**
 * The field allowlist every agent event passes through before it is written.
 *
 * Each kind keeps a fixed set of fields at a fixed size, every string goes
 * through the path rewriter, and nothing else survives: init's `cwd`,
 * `memory_paths` and `mcp_servers`, rate-limit state, sockets and the
 * initialize `account` are never read into a projected event at all.
 */
export const CODING_EVENT_LIMITS = {
  assistant: 2_000,
  user: 2_000,
  tool: 300,
  toolResult: 300,
  toolError: 1_000,
  result: 4_000,
  system: 1_000,
} as const

export type Projector = {
  /** Rewritten and capped, newlines kept (assistant prose, results). */
  text: (value: unknown, max: number) => string
  /** Rewritten, collapsed to one line and capped (summaries). */
  line: (value: unknown, max: number) => string
  toolInput: (tool: string, input: unknown) => string
  toolResult: (content: unknown, isError: boolean) => string
  denials: (value: unknown) => CodingPermissionDenial[]
}

const clip = (value: string, max: number): string => (
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
)

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const firstString = (input: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** What a tool call was about, in one line: the field a person would glance at. */
const toolSubject = (tool: string, input: unknown): string => {
  if (!record(input)) return ''
  if (['Bash', 'PowerShell', 'shell', 'command_execution'].includes(tool)) return firstString(input, ['command']) ?? ''
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return firstString(input, ['file_path', 'notebook_path', 'path']) ?? ''
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const pattern = firstString(input, ['pattern']) ?? ''
    const where = firstString(input, ['path'])
    return where ? `${pattern} in ${where}` : pattern
  }
  if (tool === 'WebFetch') return firstString(input, ['url']) ?? ''
  if (tool === 'WebSearch') return firstString(input, ['query']) ?? ''
  if (tool === 'Task' || tool === 'Agent') return firstString(input, ['description', 'subagent_type']) ?? ''
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`
  const fallback = Object.values(input).find((value) => typeof value === 'string' && value.trim())
  return typeof fallback === 'string' ? fallback : Object.keys(input).slice(0, 6).join(', ')
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => (
    record(block) && typeof block.text === 'string' ? block.text : ''
  )).filter(Boolean).join(' ')
}

export const createProjector = (rewriter: PathRewriter): Projector => {
  const text = (value: unknown, max: number): string => (
    typeof value === 'string' ? clip(rewriter.rewrite(value).trim(), max) : ''
  )
  const line = (value: unknown, max: number): string => (
    typeof value === 'string' ? clip(rewriter.rewrite(value).replace(/\s+/gu, ' ').trim(), max) : ''
  )
  return {
    text,
    line,
    toolInput: (tool, input) => line(toolSubject(tool, input), CODING_EVENT_LIMITS.tool),
    toolResult: (content, isError) => line(
      resultText(content), isError ? CODING_EVENT_LIMITS.toolError : CODING_EVENT_LIMITS.toolResult,
    ),
    denials: (value) => {
      if (!Array.isArray(value)) return []
      return value.slice(0, 20).flatMap((entry: unknown) => {
        if (!record(entry)) return []
        const tool = typeof entry.tool_name === 'string' ? entry.tool_name : typeof entry.tool === 'string' ? entry.tool : ''
        if (!tool) return []
        return [{ tool: line(tool, 80), summary: line(toolSubject(tool, entry.tool_input), CODING_EVENT_LIMITS.tool) }]
      })
    },
  }
}

// Structural, not linguistic: which program a shell command runs. The review
// reports "the last test command and its exit code", and this is how a command
// is recognised as one.
const TEST_COMMAND = new RegExp(
  '(?:^|[\\s;&|(])(?:(?:pnpm|npm|yarn|bun)\\b[^;&|]*\\s(?:run\\s+)?test(?::[\\w:-]+)?\\b'
  + '|(?:vitest|jest|pytest|mocha|rspec|phpunit)\\b|(?:go|cargo|dotnet|mvn|swift)\\s+test\\b'
  + '|node\\s+(?:[^;&|]*\\s)?--test\\b|playwright\\s+test\\b)',
  'u',
)

export const looksLikeTestCommand = (command: string): boolean => TEST_COMMAND.test(command)

/** `Exit code 3` is how Claude Code reports a failed Bash command in its tool result. */
export const exitCodeFromToolResult = (content: unknown, isError: boolean): number | null => {
  if (!isError) return 0
  const match = /Exit code (\d{1,3})\b/u.exec(resultText(content))
  return match ? Number(match[1]) : null
}
