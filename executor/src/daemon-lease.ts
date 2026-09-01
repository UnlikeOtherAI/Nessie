import { open, lstat, readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const DAEMON_LEASE_FILE = 'daemon.pid'
const MODE_MASK_GROUP_OR_OTHER = 0o077

const currentOwnerId = (): number | undefined => process.getuid?.()

const leasePath = (stateDir: string): string => resolve(stateDir, DAEMON_LEASE_FILE)

const assertOwnerOnlyLease = async (path: string): Promise<Awaited<ReturnType<typeof lstat>>> => {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Executor daemon lease must be an ordinary file.')
  }
  if (currentOwnerId() !== undefined && metadata.uid !== currentOwnerId()) {
    throw new Error('Executor daemon lease must be owned by the current user.')
  }
  if ((metadata.mode & MODE_MASK_GROUP_OR_OTHER) !== 0) {
    throw new Error('Executor daemon lease must not be accessible by other users.')
  }
  return metadata
}

const processIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

const staleLease = async (path: string): Promise<boolean> => {
  const value = (await readFile(path, 'utf8')).trim()
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error('Executor daemon lease is malformed.')
  }
  return !processIsLive(Number(value))
}

export type ExecutorDaemonLease = { release: () => Promise<void> }

/**
 * A secure, process-lifetime lease prevents an app restart from starting a
 * second daemon for the same executor while the first one still tears down its
 * guest sessions. The lease is not an authorization proof; the server's
 * connection epoch remains the distributed fence.
 */
export const acquireExecutorDaemonLease = async (stateDir: string): Promise<ExecutorDaemonLease> => {
  const path = leasePath(stateDir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        const metadata = await assertOwnerOnlyLease(path)
        return {
          release: async () => {
            const current = await assertOwnerOnlyLease(path).catch(() => undefined)
            if (current?.ino === metadata.ino) await unlink(path).catch(() => undefined)
          },
        }
      } catch (error) {
        await unlink(path).catch(() => undefined)
        throw error
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await assertOwnerOnlyLease(path)
      if (!await staleLease(path)) {
        throw new Error('EXECUTOR_DAEMON_ALREADY_RUNNING')
      }
      await unlink(path)
    }
  }
  throw new Error('EXECUTOR_DAEMON_LEASE_RACE')
}
