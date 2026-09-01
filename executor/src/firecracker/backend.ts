import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, link, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { secureFirecrackerJailDirectory } from '../guest-vm-artifacts.js'
import {
  GUEST_VM_SESSION_ID_MAX_CHARS,
  guestVmSessionProcess,
  stopChildProcess,
  waitForChildExit,
  type ActiveGuestVmSessionProcess,
  type GuestVmBackend,
  type GuestVmBackendStartInput,
} from '../guest-vm-backend.js'
import { GuestVmControlClient } from '../guest-vm-control.js'
import { WorkspacePathError } from '../workspace-paths.js'
import {
  configureFirecrackerMicroVm,
  sendFirecrackerCtrlAltDel,
  startFirecrackerInstance,
} from './api.js'
import { startGuestControlChannel } from './control-channel.js'
import { startGuestEgressBridge, type GuestEgressBridge } from './egress-bridge.js'
import {
  assertJailerPrivileges,
  buildJailerArgv,
  defaultJailerPrivilegeProbe,
  jailerLayout,
  resolveJailerBinary,
  JAILED_INITRD_NAME,
  JAILED_KERNEL_NAME,
  JAILED_VSOCK_NAME,
  type JailerPrivilegeProbe,
} from './jailer.js'

/**
 * Firecracker's guest CID. The host is always 2 (docs/vsock.md); 3 is the
 * conventional first guest CID and each micro-VM has its own vsock device
 * backed by its own jailed Unix socket, so the value never collides.
 */
const GUEST_CID = 3
const API_SOCKET_POLL_INTERVAL_MS = 25
const API_SOCKET_TIMEOUT_MS = 10_000
const GRACEFUL_STOP_TIMEOUT_MS = 10_000

export type FirecrackerProcessSpawner = (path: string, argv: string[]) => ChildProcess

const spawnJailer: FirecrackerProcessSpawner = (path, argv) =>
  // argv is a list, never a shell string: nothing here is interpreted by a
  // shell, so a path can never become an argument.
  spawn(path, argv, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })

/** The jailer builds the chroot asynchronously; the API socket is its "ready". */
const awaitApiSocket = async (
  apiSocketPath: string,
  child: ChildProcess,
  now: () => number,
): Promise<void> => {
  const deadline = now() + API_SOCKET_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new WorkspacePathError('The executor micro-VM jailer exited before its control socket appeared.')
    }
    const info = await stat(apiSocketPath).catch(() => undefined)
    if (info?.isSocket()) return
    if (now() >= deadline) {
      throw new WorkspacePathError('The executor micro-VM did not open its control socket in time.')
    }
    await delay(API_SOCKET_POLL_INTERVAL_MS)
  }
}

/**
 * docs/jailer.md: "The user must create hard links for (or copy) any resources
 * which will be provided to the VM via the API ... inside the jailed root
 * folder." A hard link is preferred — a guest kernel is tens of megabytes —
 * and a copy is used only when the source is on another filesystem, where a
 * link is not merely slower but impossible.
 */
const placeInJail = async (source: string, destination: string): Promise<void> => {
  try {
    await link(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw new WorkspacePathError('The executor micro-VM could not stage its boot images in the session jail.')
    }
    await copyFile(source, destination)
  }
}

/**
 * The guest's kernel command line. `console=ttyS0 reboot=k panic=1 pci=off` is
 * Firecracker's own documented baseline (docs/initrd.md); `rdinit=/init` names
 * the guest init inside the initrd; and the `nessie.*` flags are the exact
 * ones `executor/guest` reads back out of /proc/cmdline, so the guest cannot
 * tell the two hypervisors apart.
 */
export const guestBootArgs = (input: {
  egress: boolean
  runtimeManifestDigest: string
}): string => [
  'console=ttyS0',
  'reboot=k',
  'panic=1',
  'pci=off',
  'rdinit=/init',
  `nessie.runtime_manifest=${input.runtimeManifestDigest}`,
  'nessie.runtime=1',
  'nessie.workspace=1',
  ...(input.egress ? ['nessie.egress=1'] : []),
].join(' ')

type FirecrackerSessionResources = {
  bridge?: GuestEgressBridge
  channel?: Awaited<ReturnType<typeof startGuestControlChannel>>
  child?: ChildProcess
  chrootDirectory?: string
}

/**
 * Tears a session down in the reverse of the order it was built, and never
 * leaves a chroot or a Unix socket behind: the jail carries the boot images,
 * the API socket, and both guest channels, so a surviving directory is a
 * surviving capability.
 */
const releaseSession = async (resources: FirecrackerSessionResources): Promise<void> => {
  await resources.bridge?.close().catch(() => undefined)
  await resources.channel?.close().catch(() => undefined)
  if (resources.child) await stopChildProcess(resources.child, GRACEFUL_STOP_TIMEOUT_MS).catch(() => undefined)
  if (resources.chrootDirectory) {
    await rm(resources.chrootDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

export type FirecrackerBackendDependencies = {
  now?: () => number
  privilegeProbe?: JailerPrivilegeProbe
  /** Injected in tests; production spawns the real jailer. */
  spawnProcess?: FirecrackerProcessSpawner
}

/**
 * Linux: one jailer-isolated Firecracker micro-VM per session. No network
 * interface is ever configured — the guest's only route off the machine is the
 * forced egress gateway over vsock, exactly as under Virtualization.framework.
 *
 * On Linux the executor's stored `vmHelperPath` is the Firecracker binary, and
 * the jailer is its sibling `jailer` in the same owner-only directory.
 */
export const createFirecrackerBackend = (
  dependencies: FirecrackerBackendDependencies = {},
): GuestVmBackend => {
  const now = dependencies.now ?? Date.now
  const spawnProcess = dependencies.spawnProcess ?? spawnJailer
  const privilegeProbe = dependencies.privilegeProbe ?? defaultJailerPrivilegeProbe()
  return {
    kind: 'firecracker',
    start: async (input: GuestVmBackendStartInput): Promise<ActiveGuestVmSessionProcess> => {
      const identity = assertJailerPrivileges(privilegeProbe)
      const jailerPath = await resolveJailerBinary(input.vmHelperPath)
      const chrootBaseDirectory = await secureFirecrackerJailDirectory(GUEST_VM_SESSION_ID_MAX_CHARS)
      const layout = jailerLayout({
        chrootBaseDirectory,
        firecrackerPath: input.vmHelperPath,
        sessionId: input.sessionId,
      })
      const resources: FirecrackerSessionResources = { chrootDirectory: chrootBaseDirectory }
      try {
        const child = spawnProcess(jailerPath, buildJailerArgv({
          chrootBaseDirectory,
          firecrackerPath: input.vmHelperPath,
          gid: identity.gid,
          sessionId: input.sessionId,
          uid: identity.uid,
        }))
        resources.child = child
        await awaitApiSocket(layout.apiSocketPath, child, now)
        await Promise.all([
          placeInJail(input.kernelPath, join(layout.chrootDirectory, JAILED_KERNEL_NAME)),
          placeInJail(input.initrdPath, join(layout.chrootDirectory, JAILED_INITRD_NAME)),
        ])
        await configureFirecrackerMicroVm(layout.apiSocketPath, {
          bootArgs: guestBootArgs({
            egress: Boolean(input.egressGatewaySocketPath),
            runtimeManifestDigest: input.runtimeManifestDigest,
          }),
          guestCid: GUEST_CID,
          initrdPath: `/${JAILED_INITRD_NAME}`,
          kernelPath: `/${JAILED_KERNEL_NAME}`,
          memoryMiB: input.resources.memoryMiB,
          udsPath: `/${JAILED_VSOCK_NAME}`,
          vcpuCount: input.resources.vcpuCount,
        })
        // Both guest channels must be listening before the guest can connect,
        // or Firecracker resets the guest's connection (docs/vsock.md).
        resources.channel = await startGuestControlChannel(layout.vsockPath, input.bootstrapToken)
        if (input.egressGatewaySocketPath) {
          resources.bridge = await startGuestEgressBridge({
            bootstrapToken: input.bootstrapToken,
            gatewaySocketPath: input.egressGatewaySocketPath,
            vsockPath: layout.vsockPath,
          })
        }
        await startFirecrackerInstance(layout.apiSocketPath)
        // The same budget covers both halves of becoming ready: a guest that
        // never dials the control port is exactly as dead as one that dials
        // and never authenticates, and neither may hold a session open.
        const guest = await Promise.race([
          resources.channel.connected,
          delay(input.readyTimeoutMs).then(() => {
            throw new WorkspacePathError('The executor guest did not open its control channel in time.')
          }),
        ])
        const control = new GuestVmControlClient(guest.input, guest.output)
        await control.waitForReady(input.readyTimeoutMs)
        let stopping: Promise<void> | undefined
        const closed = waitForChildExit(child).finally(async () => {
          control.close()
          await releaseSession({ ...resources, child: undefined })
        })
        const stop = async (): Promise<void> => {
          stopping ??= (async () => {
            // Closing the control channel is what actually ends this guest: its
            // init returns on EOF. SendCtrlAltDel is the documented graceful
            // action and is attempted anyway, but it is Intel/AMD only, so its
            // refusal must never become the session's failure.
            guest.input.end()
            await sendFirecrackerCtrlAltDel(layout.apiSocketPath).catch(() => undefined)
            await Promise.race([closed, delay(GRACEFUL_STOP_TIMEOUT_MS)])
            await releaseSession(resources)
          })()
          await stopping
        }
        return guestVmSessionProcess(control, { closed, stop })
      } catch (error) {
        await releaseSession(resources)
        throw error
      }
    },
  }
}
