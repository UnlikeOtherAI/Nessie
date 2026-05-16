import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import {
  assertInsideSandbox,
  extractSandboxConfig,
  type SandboxConfig,
} from './sandbox.js'

const DEFAULT_LIMIT = 1000

const InputSchema = z.object({
  pattern: z.string().min(1),
  cwd: z.string().min(1).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
})

export type FileGlobInput = z.infer<typeof InputSchema>

export type FileGlobOutput = {
  pattern: string
  cwd: string
  matches: string[]
  truncated: boolean
}

const TOOL_ID = 'file_glob'

/**
 * Compile a single glob segment to a RegExp. Supports `*`, `?`, and `[...]`.
 * `**` is handled separately in the walker (matches across path segments).
 */
const compileSegment = (segment: string): RegExp => {
  let pattern = '^'
  let index = 0
  while (index < segment.length) {
    const char = segment.charAt(index)
    if (char === '*') {
      pattern += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const end = segment.indexOf(']', index + 1)
      if (end === -1) {
        pattern += '\\['
        index += 1
        continue
      }
      pattern += `[${segment.slice(index + 1, end)}]`
      index = end + 1
      continue
    }
    pattern += char.replace(/[.+^${}()|\\]/g, '\\$&')
    index += 1
  }
  pattern += '$'
  return new RegExp(pattern)
}

type CompiledSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'pattern'; regex: RegExp }
  | { kind: 'recursive' }

const compilePattern = (pattern: string): CompiledSegment[] => {
  const parts = pattern.split('/').filter((segment) => segment.length > 0)
  return parts.map((segment) => {
    if (segment === '**') {
      return { kind: 'recursive' }
    }
    if (/[*?[]/.test(segment)) {
      return { kind: 'pattern', regex: compileSegment(segment) }
    }
    return { kind: 'literal', value: segment }
  })
}

const walkGlob = async (
  cwd: string,
  segments: CompiledSegment[],
  sandbox: SandboxConfig,
  limit: number,
  matches: string[],
): Promise<boolean> => {
  if (matches.length >= limit) {
    return true
  }

  if (segments.length === 0) {
    return false
  }

  const [head, ...rest] = segments
  if (head === undefined) {
    return false
  }

  if (head.kind === 'recursive') {
    // `**` matches zero or more directory levels — try matching the remaining
    // segments at the current dir, then descend into each subdir keeping `**`.
    const truncated = await walkGlob(cwd, rest, sandbox, limit, matches)
    if (truncated) {
      return true
    }
    let entries: Dirent[]
    try {
      entries = (await readdir(cwd, { withFileTypes: true })) as Dirent[]
    } catch {
      return false
    }
    for (const entry of entries) {
      if (matches.length >= limit) {
        return true
      }
      if (!entry.isDirectory()) {
        continue
      }
      const child = join(cwd, entry.name)
      try {
        await assertInsideSandbox(child, sandbox, TOOL_ID)
      } catch {
        continue
      }
      const childTruncated = await walkGlob(
        child,
        segments,
        sandbox,
        limit,
        matches,
      )
      if (childTruncated) {
        return true
      }
    }
    return false
  }

  let entries: Dirent[]
  try {
    entries = (await readdir(cwd, { withFileTypes: true })) as Dirent[]
  } catch {
    return false
  }

  for (const entry of entries) {
    if (matches.length >= limit) {
      return true
    }
    const isMatch =
      head.kind === 'literal' ? entry.name === head.value : head.regex.test(entry.name)
    if (!isMatch) {
      continue
    }
    const childPath = join(cwd, entry.name)
    try {
      await assertInsideSandbox(childPath, sandbox, TOOL_ID)
    } catch {
      continue
    }

    if (rest.length === 0) {
      matches.push(childPath)
      if (matches.length >= limit) {
        return true
      }
      continue
    }

    if (!entry.isDirectory()) {
      continue
    }
    const childTruncated = await walkGlob(
      childPath,
      rest,
      sandbox,
      limit,
      matches,
    )
    if (childTruncated) {
      return true
    }
  }

  return false
}

export const runFileGlob = async (
  rawArgs: unknown,
  transportConfig: unknown,
): Promise<FileGlobOutput> => {
  const input = InputSchema.parse(rawArgs)
  const sandbox = await extractSandboxConfig(transportConfig, TOOL_ID)
  const candidateCwd = input.cwd ?? sandbox.allowedRoots[0]
  if (candidateCwd === undefined) {
    // extractSandboxConfig already guarantees at least one root, but keep this
    // explicit for the type narrowing.
    throw new Error('file_glob requires at least one allowed root.')
  }
  const cwd = await assertInsideSandbox(candidateCwd, sandbox, TOOL_ID)
  const limit = input.limit ?? DEFAULT_LIMIT
  const segments = compilePattern(input.pattern)

  if (segments.length === 0) {
    return { pattern: input.pattern, cwd, matches: [], truncated: false }
  }

  const matches: string[] = []
  const truncated = await walkGlob(cwd, segments, sandbox, limit, matches)
  return { pattern: input.pattern, cwd, matches, truncated }
}
