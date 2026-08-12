import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { WorkspacePathError } from './workspace-paths.js'

const MANIFEST_FILE = 'nessie-guest-runtime.json'
const MAX_RUNTIME_FILES = 4_096
const SHA256 = /^[a-f0-9]{64}$/

type GuestRuntimeManifestFile = {
  executable: boolean
  path: string
  sha256: string
}

export type VerifiedGuestRuntimeBundle = {
  entrypoints: {
    browser?: string
    claude?: string
    codex?: string
    tmux?: string
  }
  manifestDigest: string
  root: string
}

const ownerId = (): number | undefined => process.getuid?.()

const invalid = (message: string): never => {
  throw new WorkspacePathError(`The guest runtime bundle ${message}.`)
}

const relativeFilePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\\')) {
    return invalid('contains an invalid file path')
  }
  const pieces = value.split('/')
  if (pieces.some((piece) => piece.length === 0 || piece === '.' || piece === '..')) {
    return invalid('contains an invalid file path')
  }
  return value
}

const fileDigest = async (path: string): Promise<string> => {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

const assertOwnerPrivateDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || (ownerId() !== undefined && info.uid !== ownerId())
    || (info.mode & 0o077) !== 0
  ) {
    invalid('directory must be owner-private and non-symbolic')
  }
}

const parseManifest = (value: unknown): {
  entrypoints: VerifiedGuestRuntimeBundle['entrypoints']
  files: GuestRuntimeManifestFile[]
} => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('manifest is malformed')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1
    || !Array.isArray(record.files)
    || record.files.length === 0
    || record.files.length > MAX_RUNTIME_FILES
  ) {
    invalid('manifest is malformed')
  }
  const rawFiles = record.files as unknown[]
  const files = rawFiles.map((raw): GuestRuntimeManifestFile => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('manifest is malformed')
    const file = raw as Record<string, unknown>
    const executable = file.executable
    const sha256 = file.sha256
    if (typeof executable !== 'boolean' || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      invalid('manifest is malformed')
    }
    return {
      executable: executable as boolean,
      path: relativeFilePath(file.path),
      sha256: sha256 as string,
    }
  })
  if (new Set(files.map((file) => file.path)).size !== files.length) invalid('manifest repeats a file')

  const rawEntrypoints = record.entrypoints
  if (!rawEntrypoints || typeof rawEntrypoints !== 'object' || Array.isArray(rawEntrypoints)) {
    invalid('manifest is malformed')
  }
  const entrypointRecord = rawEntrypoints as Record<string, unknown>
  const entrypoints: VerifiedGuestRuntimeBundle['entrypoints'] = {}
  for (const name of ['browser', 'tmux', 'codex', 'claude'] as const) {
    const candidate = entrypointRecord[name]
    if (candidate === undefined) continue
    entrypoints[name] = relativeFilePath(candidate)
  }
  if (!entrypoints.browser && !entrypoints.tmux) invalid('does not declare a browser or tmux entrypoint')
  const executableFiles = new Set(files.filter((file) => file.executable).map((file) => file.path))
  if (Object.values(entrypoints).some((path) => path && !executableFiles.has(path))) {
    invalid('entrypoint is not a declared executable')
  }
  return { entrypoints, files }
}

const walkBundle = async (root: string, directory = root): Promise<string[]> => {
  await assertOwnerPrivateDirectory(directory)
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkBundle(root, path))
      continue
    }
    const rel = relative(root, path).split(sep).join('/')
    if (!entry.isFile() || entry.isSymbolicLink()) invalid('contains a non-regular file')
    files.push(rel)
  }
  return files
}

/**
 * Verifies a complete, owner-private runtime payload. The verified root is an
 * artifact reference only: it is never executed on the host and a session must
 * still mount a separately packaged guest image before an operation is exposed.
 */
export const verifyGuestRuntimeBundle = async (rawRoot: string): Promise<VerifiedGuestRuntimeBundle> => {
  if (!isAbsolute(rawRoot)) invalid('path must be absolute')
  const root = resolve(rawRoot)
  await assertOwnerPrivateDirectory(root)
  const manifestPath = resolve(root, MANIFEST_FILE)
  const manifestInfo = await lstat(manifestPath).catch(() => invalid('manifest is missing'))
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (manifestInfo.mode & 0o077) !== 0) {
    invalid('manifest must be owner-private and non-symbolic')
  }
  const manifestBytes = await readFile(manifestPath)
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    invalid('manifest is malformed')
  }
  const manifest = parseManifest(parsed)
  const declared = new Map(manifest.files.map((file) => [file.path, file]))
  const actualFiles = await walkBundle(root)
  const runtimeFiles = actualFiles.filter((path) => path !== MANIFEST_FILE)
  if (runtimeFiles.length !== declared.size || runtimeFiles.some((path) => !declared.has(path))) {
    invalid('does not match its declared file set')
  }
  for (const [path, file] of declared) {
    const absolute = resolve(root, path)
    if (!absolute.startsWith(`${root}${sep}`)) invalid('contains an invalid file path')
    const info = await lstat(absolute)
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.nlink !== 1
      || (ownerId() !== undefined && info.uid !== ownerId())
      || (info.mode & 0o077) !== 0
      || (file.executable && (info.mode & constants.S_IXUSR) === 0)
      || (!file.executable && (info.mode & constants.S_IXUSR) !== 0)
      || await fileDigest(absolute) !== file.sha256
    ) {
      invalid('file integrity check failed')
    }
  }
  return {
    entrypoints: manifest.entrypoints,
    manifestDigest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
    root,
  }
}
