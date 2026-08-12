import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertExecutorEgressOrigin,
  compileExecutorEgressPolicy,
  type ExecutorEgressPolicy,
} from './egress-policy.js'
import { startExecutorEgressGateway } from './egress-gateway.js'
import {
  GUEST_VM_BUILD_TIMEOUT_MS,
  GUEST_VM_HANDSHAKE_TIMEOUT_MS,
  runGuestVmProcess,
  secureGuestVmGatewayDirectory,
  secureGuestVmSessionDirectory,
  type GuestVmProcessRunner,
  verifyPrivateGuestVmFile,
} from './guest-vm-artifacts.js'
import { GuestVmControlClient, type GuestRuntimeInspection } from './guest-vm-control.js'
import {
  materializeGuestRuntimeBundle,
  removeGuestRuntimeBundleSnapshot,
  verifyGuestRuntimeBundle,
} from './guest-runtime-bundle.js'
import type { GuestVmHandshakeInput } from './guest-vm-handshake.js'
import {
  assertGuestWorkspaceLeaseCurrent,
  releaseGuestWorkspaceLease,
} from './guest-workspace-lease.js'
import { WorkspacePathError } from './workspace-paths.js'

const SESSION_STOP_TIMEOUT_MS = 10_000

type ActiveGuestVmSessionProcess = {
  closed: Promise<void>
  inspectRuntime: () => Promise<GuestRuntimeInspection>
  openBrowser: (url: string) => Promise<void>
  stop: () => Promise<void>
}

type GuestVmSessionLauncher = (input: {
  argv: string[]
  input: string
  path: string
  readyTimeoutMs: number
}) => Promise<ActiveGuestVmSessionProcess>

export type GuestVmSessionInput = GuestVmHandshakeInput & {
  egressPolicy: ExecutorEgressPolicy
  guestRuntimeBundlePath: string
}

export type GuestVmSession = {
  closed: Promise<void>
  inspectRuntime: () => Promise<GuestRuntimeInspection>
  openBrowser: (url: string) => Promise<void>
  stop: () => Promise<void>
}

const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolvePromise) => {
  child.once('error', () => resolvePromise())
  child.once('exit', () => resolvePromise())
})

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = waitForExit(child)
  child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    exited,
    new Promise<void>((resolvePromise) => {
      timeout = setTimeout(resolvePromise, SESSION_STOP_TIMEOUT_MS)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

const launchGuestVmSession: GuestVmSessionLauncher = async ({ argv, input, path, readyTimeoutMs }) => {
  const child = spawn(path, argv, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  if (!child.stdin || !child.stdout) throw new WorkspacePathError('The executor VM helper is unavailable.')
  const control = new GuestVmControlClient(child.stdin, child.stdout)
  const closed = waitForExit(child).finally(() => control.close())
  try {
    child.stdin.write(input)
    await control.waitForReady(readyTimeoutMs)
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return {
    closed,
    inspectRuntime: () => control.inspectRuntime(),
    openBrowser: (url) => control.openBrowser(url),
    stop: () => stopChild(child),
  }
}

/**
 * Starts one lease-bound guest VM and its owner-only forced-egress gateway.
 * This is companion infrastructure only: callers hold the returned session and
 * must stop it; no executor descriptor or daemon operation calls this yet.
 */
export const startGuestVmSession = async (
  input: GuestVmSessionInput,
  dependencies: {
    launchProcess?: GuestVmSessionLauncher
    runProcess?: GuestVmProcessRunner
  } = {},
): Promise<GuestVmSession> => {
  const egressSettings = compileExecutorEgressPolicy(input.egressPolicy)
  await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
  const [builderPath, kernelPath, helperPath] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
  ])
  const runtimeBundle = await verifyGuestRuntimeBundle(input.guestRuntimeBundlePath)
  const sessionDirectory = await secureGuestVmSessionDirectory(input.stateDir, input.lease)
  const initrdPath = join(sessionDirectory, 'guest-initrd')
  const consolePath = join(sessionDirectory, 'console')
  const gatewayDirectory = await secureGuestVmGatewayDirectory()
  const gatewayPath = join(gatewayDirectory, 'egress.sock')
  const bootstrapToken = randomBytes(32).toString('base64url')
  const runProcess = dependencies.runProcess ?? runGuestVmProcess
  const launchProcess = dependencies.launchProcess ?? launchGuestVmSession
  let process: ActiveGuestVmSessionProcess | undefined
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await gateway?.close().catch(() => undefined)
    await removeGuestRuntimeBundleSnapshot(join(sessionDirectory, 'runtime')).catch(() => undefined)
    await rm(sessionDirectory, { force: true, recursive: true })
    await rm(gatewayDirectory, { force: true, recursive: true })
    await releaseGuestWorkspaceLease(input.stateDir, input.lease).catch(() => undefined)
  }
  let gateway: Awaited<ReturnType<typeof startExecutorEgressGateway>> | undefined
  try {
    const runtimeSnapshot = await materializeGuestRuntimeBundle(runtimeBundle, join(sessionDirectory, 'runtime'))
    gateway = await startExecutorEgressGateway({ policy: input.egressPolicy, socketPath: gatewayPath })
    await runProcess({
      argv: ['--output', initrdPath, '--bootstrap-token-stdin'],
      input: bootstrapToken,
      path: builderPath,
      timeoutMs: GUEST_VM_BUILD_TIMEOUT_MS,
    })
    await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
    process = await launchProcess({
      argv: [
        'session',
        '--console', consolePath,
        '--kernel', kernelPath,
        '--initrd', initrdPath,
        '--workspace-cow', input.lease.workspace,
        '--runtime-bundle', runtimeSnapshot.root,
        '--runtime-manifest-digest', runtimeSnapshot.manifestDigest,
        '--egress-gateway', gateway.socketPath,
        '--bootstrap-token-stdin',
      ],
      input: bootstrapToken,
      path: helperPath,
      readyTimeoutMs: GUEST_VM_HANDSHAKE_TIMEOUT_MS,
    })
    const closed = process.closed.finally(cleanup)
    return {
      closed,
      inspectRuntime: () => process!.inspectRuntime(),
      openBrowser: async (url: string) => {
        assertExecutorEgressOrigin(url, egressSettings)
        await process!.openBrowser(url)
      },
      stop: async () => {
        await process?.stop()
        await closed
      },
    }
  } catch (error) {
    await process?.stop().catch(() => undefined)
    await cleanup()
    throw error
  }
}
