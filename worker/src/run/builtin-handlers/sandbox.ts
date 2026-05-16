import { resolve, sep } from 'node:path'

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
 * must opt in to a sandbox.
 */
export const extractSandboxConfig = (
  transportConfig: unknown,
  toolId: string,
): SandboxConfig => {
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
    allowedRoots.push(resolve(entry))
  }

  return { allowedRoots }
}

/**
 * Resolve a candidate path and ensure it sits inside one of the allowed roots.
 * Blocks `..` traversal — resolution happens before the prefix check.
 */
export const assertInsideSandbox = (
  candidate: string,
  sandbox: SandboxConfig,
  toolId: string,
): string => {
  const resolved = resolve(candidate)
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
