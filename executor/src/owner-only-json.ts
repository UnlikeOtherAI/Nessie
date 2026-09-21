import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'

import { assertOwnerOnlyStatePath } from './state-security.js'

/** Atomic private JSON replacement shared by paired and pending machine state. */
export const replaceOwnerOnlyJson = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertOwnerOnlyStatePath(temporaryPath, 'file')
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

