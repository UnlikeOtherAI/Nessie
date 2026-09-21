import { lstat, readdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { loadExecutorState } from './state-store.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'
import { acquireExecutorProcessLease } from './process-lease.js'

const root = (): string => resolve(homedir(), '.local/state/nessie-executor')
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const acquireDefaultPairingLease = async () => (
  acquireExecutorProcessLease(await ensureOwnerOnlyStateDirectory(root()), 'pairing-operation.pid')
)

/** Only the documented CLI root is searched; a second local binding is never implicit. */
export const defaultPairingDirectory = async (): Promise<string> => {
  const directory = await ensureOwnerOnlyStateDirectory(root())
  const paired: string[] = []
  const pending: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9-]+$/.test(entry.name)) continue
    const child = resolve(directory, entry.name)
    if (await lstat(resolve(child, 'executor-pairing-code.json')).catch((error: unknown) => {
      if (absent(error)) return null
      throw error
    })) pending.push(child)
    const state = await loadExecutorState(child).catch((error: unknown) => {
      if (absent(error)) return null
      throw error
    })
    if (state) paired.push(child)
  }
  if (new Set([...pending, ...paired]).size > 1) {
    throw new Error('This computer has several pairings. Choose the existing pairing before continuing.')
  }
  return pending[0] ?? paired[0] ?? resolve(directory, 'pairing')
}

/** systemd's fixed template resolves by executor id, assigned only after the claim. */
export const promoteDefaultPairing = async (directory: string, executorId: string): Promise<void> => {
  if (!/^[a-f0-9-]{36}$/i.test(executorId)) throw new Error('Nessie returned an invalid computer identity.')
  const destination = resolve(root(), executorId)
  if (directory === destination) return
  if (await lstat(destination).catch((error: unknown) => {
    if (absent(error)) return null
    throw error
  })) throw new Error('This computer already has that pairing.')
  await rename(directory, destination)
}
