import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

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

export type GuestVmHandshakeInput = {
  guestInitrdBuilderPath: string
  kernelPath: string
  lease: GuestWorkspaceLease
  stateDir: string
  vmHelperPath: string
}

/**
 * Runs one token-bound guest/COW handshake. This is a companion-internal
 * release probe, not an executor operation: it creates no server session and
 * cannot receive a path other than a current daemon-owned COW lease.
 */
export const runGuestVmHandshake = async (
  input: GuestVmHandshakeInput,
  dependencies: { runProcess?: GuestVmProcessRunner } = {},
): Promise<{ success: true }> => {
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
      argv: ['--output', initrdPath, '--bootstrap-token-stdin'],
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
