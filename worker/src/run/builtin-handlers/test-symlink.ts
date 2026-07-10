import { symlink } from 'node:fs/promises'

type SkippableTestContext = {
  skip: (message?: string) => void
}

const isSymlinkPermissionError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }

  const { code } = error as NodeJS.ErrnoException
  return code === 'EPERM' || code === 'EACCES'
}

export const createSymlinkOrSkip = async (
  context: SkippableTestContext,
  target: string,
  path: string,
  type: 'dir' | 'file',
): Promise<boolean> => {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    if (!isSymlinkPermissionError(error)) {
      throw error
    }

    context.skip('symlink creation is not permitted in this environment')
    return false
  }
}
