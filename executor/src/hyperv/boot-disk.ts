import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

import { WorkspacePathError } from '../workspace-paths.js'

/**
 * The boot disk: a FAT filesystem carrying `EFI\BOOT\BOOTX64.EFI` — the guest
 * kernel, built with `CONFIG_EFI_STUB`, which "can masquerade as a PE/COFF
 * image, thereby convincing EFI firmware loaders to load it as an EFI
 * executable" (Documentation/admin-guide/efi-stub.rst) — and this session's
 * initrd beside it.
 *
 * It is built with **mtools**, which reads and writes a FAT image as an
 * ordinary file. Nothing here needs a loop device, a mount, or an
 * administrator, which is the same reason the three data images are built with
 * `mke2fs -d`.
 *
 * FAT32 is forced rather than left to the size heuristic: the disk is attached
 * as a fixed SCSI drive, so the firmware treats it as a fixed disk, and the
 * UEFI specification's EFI System Partition on a fixed disk is FAT32.
 */
export const BOOT_DISK_LABEL = 'NESSIEBOOT'
export const BOOT_DISK_EFI_DIRECTORY = '::/EFI'
export const BOOT_DISK_BOOT_DIRECTORY = '::/EFI/BOOT'
/** The removable-media default path a UEFI firmware boots with no NVRAM entry. */
export const BOOT_DISK_LOADER_PATH = '::/EFI/BOOT/BOOTX64.EFI'
export const BOOT_DISK_INITRD_PATH = '::/EFI/BOOT/initrd.img'

const SECTOR_BYTES = 512
const MEBIBYTE = 1024 * 1024
/**
 * FAT32 needs at least 65,525 clusters to be FAT32 at all, so a small image
 * silently becomes FAT16 and `-F` fails instead. 64 MiB clears that with room
 * for a kernel and an initrd; the images are session-scoped and deleted on stop.
 */
const MINIMUM_BOOT_DISK_BYTES = 64 * MEBIBYTE
const BOOT_DISK_SLACK_BYTES = 8 * MEBIBYTE
const MAX_BOOT_PAYLOAD_BYTES = 256 * MEBIBYTE
export const BOOT_DISK_BUILD_TIMEOUT_MS = 120_000

/**
 * A daemon started from a service has a minimal PATH, so the tools are named
 * rather than looked up — the same treatment `guest-images.ts` gives mke2fs.
 * On Windows they ship beside the other guest resources.
 */
export type MtoolsPaths = { mcopy: string; mformat: string; mmd: string }

export const bootDiskSizeBytes = (payloadBytes: number): number => {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new WorkspacePathError('The executor guest boot payload has no readable size.')
  }
  if (payloadBytes > MAX_BOOT_PAYLOAD_BYTES) {
    throw new WorkspacePathError('The executor guest kernel and initrd exceed the boot disk limit.')
  }
  const wanted = Math.max(payloadBytes + BOOT_DISK_SLACK_BYTES, MINIMUM_BOOT_DISK_BYTES)
  return Math.ceil(wanted / MEBIBYTE) * MEBIBYTE
}

export type BootDiskPlan = ReadonlyArray<{ argv: string[]; path: string }>

/**
 * The exact command list, kept apart from running it so it can be asserted on
 * any host. `-C` makes mformat create the image file itself at `-T` sectors, so
 * nothing has to pre-allocate it; every path is a separate argv element, so a
 * session directory can never become an option.
 */
export const bootDiskPlan = (input: {
  imagePath: string
  initrdPath: string
  kernelPath: string
  sizeBytes: number
  tools: MtoolsPaths
}): BootDiskPlan => {
  if (input.sizeBytes % SECTOR_BYTES !== 0) {
    throw new WorkspacePathError('The executor guest boot disk size is invalid.')
  }
  const image = ['-i', input.imagePath]
  return [
    {
      argv: [...image, '-C', '-T', String(input.sizeBytes / SECTOR_BYTES), '-F', '-v', BOOT_DISK_LABEL, '::'],
      path: input.tools.mformat,
    },
    { argv: [...image, BOOT_DISK_EFI_DIRECTORY], path: input.tools.mmd },
    { argv: [...image, BOOT_DISK_BOOT_DIRECTORY], path: input.tools.mmd },
    { argv: [...image, input.kernelPath, BOOT_DISK_LOADER_PATH], path: input.tools.mcopy },
    { argv: [...image, input.initrdPath, BOOT_DISK_INITRD_PATH], path: input.tools.mcopy },
  ]
}

export type BootDiskSpawner = (input: {
  argv: string[]
  path: string
  timeoutMs: number
}) => Promise<void>

const runMtool: BootDiskSpawner = async ({ argv, path, timeoutMs }) => {
  await new Promise<void>((resolvePromise, reject) => {
    // argv is a list, never a shell string.
    const child = spawn(path, argv, {
      // mtools refuses a geometry it considers implausible; the image is a
      // file, not a disk, and the firmware reads the BPB rather than a
      // geometry, so the check is turned off rather than fed invented numbers.
      env: { ...process.env, MTOOLS_SKIP_CHECK: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WorkspacePathError('Building the executor guest boot disk timed out.'))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new WorkspacePathError('The executor guest boot disk builder (mtools) is unavailable.'))
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise()
      else reject(new WorkspacePathError('The executor guest boot disk could not be created.'))
    })
  })
}

export type BootDiskDependencies = { spawnProcess?: BootDiskSpawner }

export const buildGuestBootImage = async (
  input: { imagePath: string; initrdPath: string; kernelPath: string; tools: MtoolsPaths },
  dependencies: BootDiskDependencies = {},
): Promise<{ path: string; sizeBytes: number }> => {
  const spawnProcess = dependencies.spawnProcess ?? runMtool
  for (const tool of [input.tools.mformat, input.tools.mmd, input.tools.mcopy]) {
    await access(tool, constants.X_OK).catch(() => {
      throw new WorkspacePathError(
        'This computer has no mtools, so a sandboxed guest cannot be given a boot disk.',
      )
    })
  }
  const [kernel, initrd] = await Promise.all([stat(input.kernelPath), stat(input.initrdPath)])
  const sizeBytes = bootDiskSizeBytes(kernel.size + initrd.size)
  for (const step of bootDiskPlan({ ...input, sizeBytes })) {
    await spawnProcess({ ...step, timeoutMs: BOOT_DISK_BUILD_TIMEOUT_MS })
  }
  return { path: input.imagePath, sizeBytes }
}
