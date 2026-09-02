import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createFirecrackerBackend } from './firecracker/index.js'
import { createHyperVBackend } from './hyperv/index.js'
import { selectGuestVmBackend, type GuestVmBackendDependencies } from './guest-vm-backend.js'
import {
  assertGuestWorkspaceLeaseCurrent,
  releaseGuestWorkspaceLease,
  type GuestWorkspaceLease,
} from './guest-workspace-lease.js'
import {
  GUEST_VM_BUILD_TIMEOUT_MS,
  GUEST_VM_HANDSHAKE_TIMEOUT_MS,
  runGuestVmProcess,
  secureGuestVmSessionDirectory,
  type GuestVmProcessRunner,
  verifyPrivateGuestVmFile,
} from './guest-vm-artifacts.js'
import { detectExecutorHost, type ExecutorHost } from './host-platform.js'

export type GuestVmHandshakeInput = {
  guestInitrdBuilderPath: string
  kernelPath: string
  lease: GuestWorkspaceLease
  stateDir: string
  vmHelperPath: string
}

export type GuestVmHandshakeDependencies = GuestVmBackendDependencies & {
  /** Injected in tests; production reads the real host. */
  host?: ExecutorHost
  runProcess?: GuestVmProcessRunner
}

/**
 * What a handshake guest boots with on Hyper-V: the COW draft attached as a
 * block share and nothing else. It is the handshake half of the same
 * `nessie.*` vocabulary `hyperVSessionBootArgs` writes for a session — a
 * handshake carries no runtime bundle and opens no gateway, exactly as the
 * macOS helper's `handshake` attaches only `--workspace-cow`.
 */
export const HYPERV_HANDSHAKE_BOOT_ARGS = 'nessie.workspace=1 nessie.shares=block'

/**
 * Runs one token-bound guest/COW handshake. This is a companion-internal
 * release probe, not an executor operation: it creates no server session and
 * cannot receive a path other than a current daemon-owned COW lease. The
 * backend is chosen from the host's own sandbox fact exactly as a session
 * chooses it, so the initrd carries what that hypervisor needs and a host
 * reporting no backend is refused in the same words.
 */
export const runGuestVmHandshake = async (
  input: GuestVmHandshakeInput,
  dependencies: GuestVmHandshakeDependencies = {},
): Promise<{ success: true }> => {
  const backend = selectGuestVmBackend(
    dependencies.host ?? detectExecutorHost(),
    dependencies,
    () => createFirecrackerBackend(),
    () => createHyperVBackend(),
  )
  await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
  const [builderPath, kernelPath, helperPath] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
  ])
  const sessionDirectory = await secureGuestVmSessionDirectory(input.stateDir, input.lease)
  const initrdPath = join(sessionDirectory, 'guest-initrd')
  const consolePath = join(sessionDirectory, 'console')
  const bootstrapToken = randomBytes(32).toString('base64url')
  const runProcess = dependencies.runProcess ?? runGuestVmProcess
  try {
    await runProcess({
      argv: [
        '--output', initrdPath,
        // Hyper-V's generation 2 firmware supplies no UEFI load options, so a
        // guest booted there has only the command line compiled into its
        // kernel. The handshake's own arguments travel in the initrd instead;
        // every other backend writes them onto the real command line and asks
        // for none here.
        ...(backend.kind === 'hyperv' ? ['--boot-args', HYPERV_HANDSHAKE_BOOT_ARGS] : []),
        '--bootstrap-token-stdin',
      ],
      input: bootstrapToken,
      path: builderPath,
      timeoutMs: GUEST_VM_BUILD_TIMEOUT_MS,
    })
    await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
    await runProcess({
      argv: [
        'handshake',
        '--console', consolePath,
        '--kernel', kernelPath,
        '--initrd', initrdPath,
        '--workspace-cow', input.lease.workspace,
        '--bootstrap-token-stdin',
      ],
      input: bootstrapToken,
      path: helperPath,
      timeoutMs: GUEST_VM_HANDSHAKE_TIMEOUT_MS,
    })
    return { success: true }
  } finally {
    await rm(sessionDirectory, { force: true, recursive: true })
    await releaseGuestWorkspaceLease(input.stateDir, input.lease).catch(() => undefined)
  }
}
