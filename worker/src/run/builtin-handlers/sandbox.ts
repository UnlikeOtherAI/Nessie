import { realpath, lstat } from 'node:fs/promises'
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

export type SandboxRootKind = 'dir' | 'file'
export type SandboxRootAccess = 'ro' | 'rw'
export type OperationType = 'read' | 'write' | 'glob'

export type SandboxRoot = {
  path: string
  kind?: SandboxRootKind
  access?: SandboxRootAccess
}

export type SandboxConfig = {
  allowedRoots: SandboxRoot[]
}

/**
 * Read `allowedRoots` from a tool's `transportConfig`. Throws if the array is
 * missing or empty — there is no implicit fallback root. Filesystem builtins
 * must opt in to a sandbox. Each allowed root is realpath'd so a symlinked
 * root cannot bypass the prefix check downstream.
 *
 * Backward-compatible: accepts legacy `string[]` entries and normalizes them
 * to `SandboxRoot` objects with default `kind='dir'` and `access='rw'`.
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

  const allowedRoots: SandboxRoot[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      // Legacy format: normalize to SandboxRoot with defaults
      if (entry.length === 0) {
        throw new SandboxViolationError(
          `Tool ${toolId} allowedRoots must be non-empty strings.`,
        )
      }
      try {
        const real = await realpath(resolve(entry))
        allowedRoots.push({ path: real, kind: 'dir', access: 'rw' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SandboxViolationError(
            `Tool ${toolId} allowedRoot "${entry}" does not exist.`,
          )
        }
        throw err
      }
      continue
    }

    if (!entry || typeof entry !== 'object') {
      throw new SandboxViolationError(
        `Tool ${toolId} allowedRoots entries must be strings or objects.`,
      )
    }

    const obj = entry as Record<string, unknown>
    if (typeof obj.path !== 'string' || obj.path.length === 0) {
      throw new SandboxViolationError(
        `Tool ${toolId} allowedRoots object entries must have a non-empty 'path' string.`,
      )
    }

    const kind: SandboxRootKind =
      obj.kind === 'file' ? 'file' : 'dir'
    const access: SandboxRootAccess =
      obj.access === 'ro' ? 'ro' : 'rw'

    let realPath: string
    try {
      realPath = await realpath(resolve(obj.path))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SandboxViolationError(
          `Tool ${toolId} allowedRoot "${obj.path}" does not exist.`,
        )
      }
      throw err
    }

    if (kind === 'file') {
      try {
        const s = await lstat(realPath)
        if (!s.isFile()) {
          throw new SandboxViolationError(
            `Tool ${toolId} allowedRoot "${obj.path}" kind is 'file' but path is not a file.`,
          )
        }
      } catch (err) {
        if (err instanceof SandboxViolationError) throw err
        throw err
      }
    }

    allowedRoots.push({ path: realPath, kind, access })
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
 *
 * Also enforces per-root `kind` (dir/file) and `access` (ro/rw) constraints
 * based on the operation type.
 */
export const assertInsideSandbox = async (
  candidate: string,
  sandbox: SandboxConfig,
  toolId: string,
  operation?: OperationType,
): Promise<string> => {
  const resolved = await realpathCandidate(candidate)

  for (const root of sandbox.allowedRoots) {
    const rootWithSep = root.path.endsWith(sep) ? root.path : `${root.path}${sep}`
    const inside = resolved === root.path || resolved.startsWith(rootWithSep)
    if (!inside) continue

    // Enforce kind constraint
    if (root.kind === 'file') {
      if (resolved !== root.path) {
        throw new SandboxViolationError(
          `Tool ${toolId} rejected path "${candidate}" — root is a file, cannot access sub-paths.`,
        )
      }
    }

    // Enforce access constraint
    if (operation && root.access === 'ro' && operation === 'write') {
      throw new SandboxViolationError(
        `Tool ${toolId} rejected write to "${candidate}" — root is read-only.`,
      )
    }

    return resolved
  }

  throw new SandboxViolationError(
    `Tool ${toolId} rejected path "${candidate}" — outside allowedRoots.`,
  )
}
