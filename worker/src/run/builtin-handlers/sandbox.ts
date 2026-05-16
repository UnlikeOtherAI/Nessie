import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

/**
 * Error thrown when a path or pattern escapes the configured `allowedRoots`
 * sandbox. The dispatcher converts this to a structured tool failure.
 */
export class SandboxViolationError extends Error {
  override readonly name = 'SandboxViolationError'

  constructor(message: string) {
    super(message)
  }
}

export type SandboxConfig = {
  allowedRoots: string[]
}

/**
 * Read `allowedRoots` from a tool's `transportConfig`. Throws if the array is
 * missing or empty — there is no implicit fallback root. Filesystem builtins
 * must opt in to a sandbox. Each allowed root is realpath'd so a symlinked
 * root cannot bypass the prefix check downstream.
 */
export const extractSandboxConfig = async (
  transportConfig: unknown,
  toolId: string,
): Promise<SandboxConfig> => {
  if (!transportConfig || typeof transportConfig !== 'object') {
    throw new SandboxViolationError(
      `Tool ${toolId} requires transportConfig.allowedRoots; none provided.`,
    )
  }

  const raw = (transportConfig as { allowedRoots?: unknown }).allowedRoots
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SandboxViolationError(
      `Tool ${toolId} requires a non-empty transportConfig.allowedRoots array.`,
    )
  }

  const allowedRoots: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new SandboxViolationError(
        `Tool ${toolId} allowedRoots must be non-empty strings.`,
      )
    }
    try {
      allowedRoots.push(await realpath(resolve(entry)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SandboxViolationError(
          `Tool ${toolId} allowedRoot "${entry}" does not exist.`,
        )
      }
      throw err
    }
  }

  return { allowedRoots }
}

/**
 * Realpath `candidate` so symlinks are followed before the prefix check. If
 * the path does not exist (e.g. file_write target), walk up to the deepest
 * existing ancestor, realpath that, then re-append the missing tail.
 */
const realpathCandidate = async (candidate: string): Promise<string> => {
  const absolute = resolve(candidate)
  try {
    return await realpath(absolute)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    const tail: string[] = [basename(absolute)]
    let cursor = dirname(absolute)
    while (cursor !== dirname(cursor)) {
      try {
        const real = await realpath(cursor)
        return resolve(real, ...tail.reverse())
      } catch (innerErr) {
        if ((innerErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw innerErr
        }
        tail.push(basename(cursor))
        cursor = dirname(cursor)
      }
    }
    return absolute
  }
}

/**
 * Resolve a candidate path (following symlinks) and ensure it sits inside one
 * of the allowed roots. Blocks `..` traversal AND symlink escape — both are
 * eliminated before the prefix check.
 */
export const assertInsideSandbox = async (
  candidate: string,
  sandbox: SandboxConfig,
  toolId: string,
): Promise<string> => {
  const resolved = await realpathCandidate(candidate)
  for (const root of sandbox.allowedRoots) {
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
    if (resolved === root || resolved.startsWith(rootWithSep)) {
      return resolved
    }
  }

  throw new SandboxViolationError(
    `Tool ${toolId} rejected path "${candidate}" — outside allowedRoots.`,
  )
}
