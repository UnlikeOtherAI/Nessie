import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { WorkspacePathError } from '../workspace-paths.js'

/** The jailer ships beside the Firecracker binary it execs, same version. */
export const JAILER_BINARY_NAME = 'jailer'

/** docs/jailer.md: "may contain alphanumeric characters and hyphens", max 64. */
const JAILER_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * The API socket, relative to the jail root. Firecracker's own default is
 * `/run/firecracker.socket`, but the jailer creates no `/run` inside the
 * chroot, so the socket is placed at the jail root the jailer does create and
 * chown (docs/jailer.md, "Change ownership of <chroot_dir> ... so Firecracker
 * can create its API socket there").
 */
export const JAILER_API_SOCKET_NAME = 'firecracker.socket'

/** Guest-visible names; both live at the jail root, hard-linked or copied in. */
export const JAILED_KERNEL_NAME = 'vmlinux'
export const JAILED_INITRD_NAME = 'initrd.cpio'
export const JAILED_VSOCK_NAME = 'v.sock'

export type JailerLayout = {
  /** `<chroot_dir>` — the jail root as the host sees it. */
  chrootDirectory: string
  jailerPath: string
  /** Host path of the API socket Firecracker binds inside the jail. */
  apiSocketPath: string
  /** Host path of the vsock UDS Firecracker binds inside the jail. */
  vsockPath: string
}

/**
 * docs/jailer.md: the jailer creates
 * `<chroot_base>/<exec_file_name>/<id>/root`, copies the exec file in, and
 * chowns that directory to `<uid>:<gid>`.
 */
export const jailerLayout = (input: {
  chrootBaseDirectory: string
  firecrackerPath: string
  sessionId: string
}): JailerLayout => {
  if (!JAILER_ID.test(input.sessionId)) {
    throw new WorkspacePathError('The executor micro-VM session id is not a valid jailer id.')
  }
  const chrootDirectory = join(
    input.chrootBaseDirectory,
    basename(input.firecrackerPath),
    input.sessionId,
    'root',
  )
  return {
    apiSocketPath: join(chrootDirectory, JAILER_API_SOCKET_NAME),
    chrootDirectory,
    jailerPath: join(dirname(input.firecrackerPath), JAILER_BINARY_NAME),
    vsockPath: join(chrootDirectory, JAILED_VSOCK_NAME),
  }
}

/**
 * The jailer's argv, as a list — never a shell string. Everything after `--`
 * is forwarded to Firecracker (docs/jailer.md, "end of command options"), and
 * the jailer already passes `--id` to Firecracker itself.
 */
export const buildJailerArgv = (input: {
  chrootBaseDirectory: string
  firecrackerPath: string
  gid: number
  sessionId: string
  uid: number
}): string[] => {
  if (!JAILER_ID.test(input.sessionId)) {
    throw new WorkspacePathError('The executor micro-VM session id is not a valid jailer id.')
  }
  if (!Number.isInteger(input.uid) || input.uid < 0 || !Number.isInteger(input.gid) || input.gid < 0) {
    throw new WorkspacePathError('The executor daemon has no usable uid and gid for the micro-VM jail.')
  }
  return [
    '--id', input.sessionId,
    '--exec-file', input.firecrackerPath,
    '--uid', String(input.uid),
    '--gid', String(input.gid),
    '--chroot-base-dir', input.chrootBaseDirectory,
    // cgroup v2 with no `--cgroup` value: the jailer then moves the process
    // into `--parent-cgroup` if it exists and otherwise proceeds without
    // creating one, which is what an unprivileged deployment can rely on.
    '--cgroup-version', '2',
    '--',
    '--api-sock', `/${JAILER_API_SOCKET_NAME}`,
  ]
}

const JAILER_PRIVILEGE_REMEDY =
  'The Firecracker jailer must run as root: it unshares a mount namespace, pivot_roots into the '
  + 'session chroot, and mknods /dev/kvm before dropping to the daemon\'s own uid and gid '
  + '(Firecracker docs/jailer.md: "We run the jailer as the root user; it actually requires a '
  + 'more restricted set of capabilities, but that\'s to be determined as features stabilize."). '
  + 'Run the executor through the packaged system service, which starts privileged and hands the '
  + 'guest back to your account, rather than from an unprivileged shell.'

export type JailerPrivilegeProbe = {
  getgid: () => number | undefined
  getuid: () => number | undefined
}

export const defaultJailerPrivilegeProbe = (): JailerPrivilegeProbe => ({
  getgid: () => process.getgid?.(),
  getuid: () => process.getuid?.(),
})

/**
 * Fails closed at session start rather than letting the jailer die halfway
 * through building a chroot. The identity it needs is twofold: it must itself
 * be root to build the jail, and it needs the daemon's own uid/gid to hand the
 * jailed Firecracker back to this account.
 */
export const assertJailerPrivileges = (
  probe: JailerPrivilegeProbe = defaultJailerPrivilegeProbe(),
): { gid: number; uid: number } => {
  const uid = probe.getuid()
  const gid = probe.getgid()
  if (uid === undefined || gid === undefined) {
    throw new WorkspacePathError('This platform reports no process uid and gid, so the micro-VM jail cannot be built.')
  }
  if (uid !== 0) throw new WorkspacePathError(JAILER_PRIVILEGE_REMEDY)
  return { gid, uid }
}

/** The jailer must be the executable sibling of the Firecracker binary. */
export const resolveJailerBinary = async (firecrackerPath: string): Promise<string> => {
  const jailerPath = join(dirname(firecrackerPath), JAILER_BINARY_NAME)
  const info = await lstat(jailerPath).catch(() => undefined)
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspacePathError(
      `The Firecracker jailer must be installed beside the firecracker binary at ${jailerPath}.`,
    )
  }
  await access(jailerPath, constants.X_OK).catch(() => {
    throw new WorkspacePathError(`The Firecracker jailer at ${jailerPath} is not executable.`)
  })
  return jailerPath
}
