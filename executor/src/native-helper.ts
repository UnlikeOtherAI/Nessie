import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import type { SandboxPromotionManifest } from './sandbox-workspace.js'

const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024
const NATIVE_PROMOTION_TIMEOUT_MS = 20_000

const ownerId = (): number | undefined => process.getuid?.()

export const verifyNativeHelperPath = async (value: string): Promise<string> => {
  if (!isAbsolute(value)) throw new Error('The native helper path must be absolute.')
  const declared = resolve(value)
  const declaredInfo = await lstat(declared)
  if (declaredInfo.isSymbolicLink() || !declaredInfo.isFile()) {
    throw new Error('The native helper must be an ordinary executable file.')
  }
  const canonical = await realpath(declared)
  const current = await lstat(canonical)
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || (ownerId() !== undefined && current.uid !== ownerId())
    || (current.mode & 0o077) !== 0
    || (current.mode & 0o100) === 0
  ) {
    throw new Error('The native helper must be owner-only and executable.')
  }
  return canonical
}

type NativePromotionRequest = SandboxPromotionManifest & {
  approvalDigest: string
  bindingFence: string
  promotionId: string
}

type NativePromotionResult = {
  code?: string
  manifestDigest?: string
  promotionId?: string
  runId?: string
  status?: string
}

const nativeFailure = (code: string): Record<string, unknown> => ({ code, success: false })

/**
 * Runs only a verified owner-controlled native helper with root and draft
 * directory descriptors. Host and draft paths never enter its JSON or argv.
 */
export const applyNativePromotion = async (input: {
  draftWorkspace: string
  helperPath: string | undefined
  request: NativePromotionRequest
  workspaceRoot: string
}): Promise<Record<string, unknown>> => {
  if (!input.helperPath) return nativeFailure('EXECUTOR_NATIVE_HELPER_UNAVAILABLE')
  let helperPath: string
  try {
    helperPath = await verifyNativeHelperPath(input.helperPath)
  } catch {
    return nativeFailure('EXECUTOR_NATIVE_HELPER_UNAVAILABLE')
  }
  const [root, draft] = await Promise.all([
    open(input.workspaceRoot, constants.O_RDONLY | constants.O_NOFOLLOW),
    open(input.draftWorkspace, constants.O_RDONLY | constants.O_NOFOLLOW),
  ])
  try {
    return await new Promise<Record<string, unknown>>((resolvePromise) => {
      const child = spawn(helperPath, ['workspace-apply'], {
        stdio: ['pipe', 'pipe', 'ignore', root.fd, draft.fd],
        windowsHide: true,
      })
      const stdin = child.stdin
      const stdout = child.stdout
      if (!stdin || !stdout) {
        child.kill('SIGKILL')
        resolvePromise(nativeFailure('EXECUTOR_NATIVE_HELPER_UNAVAILABLE'))
        return
      }
      let output = Buffer.alloc(0)
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      const finish = (result: Record<string, unknown>) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        resolvePromise(result)
      }
      timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish(nativeFailure('EXECUTOR_PROMOTION_TIMEOUT'))
      }, NATIVE_PROMOTION_TIMEOUT_MS)
      child.once('error', () => finish(nativeFailure('EXECUTOR_NATIVE_HELPER_UNAVAILABLE')))
      stdout.on('data', (chunk: Buffer) => {
        output = Buffer.concat([output, chunk])
        if (output.byteLength > MAX_NATIVE_RESPONSE_BYTES) {
          child.kill('SIGKILL')
          finish(nativeFailure('EXECUTOR_PROMOTION_RESULT_INVALID'))
        }
      })
      child.once('close', () => {
        if (settled) return
        let parsed: NativePromotionResult
        try {
          parsed = JSON.parse(output.toString('utf8')) as NativePromotionResult
        } catch {
          finish(nativeFailure('EXECUTOR_PROMOTION_RESULT_INVALID'))
          return
        }
        if (
          parsed.status !== 'applied'
          || parsed.manifestDigest !== input.request.manifestDigest
          || parsed.promotionId !== input.request.promotionId
          || parsed.runId !== input.request.runId
        ) {
          finish(nativeFailure(typeof parsed.code === 'string' ? parsed.code : 'EXECUTOR_PROMOTION_REJECTED'))
          return
        }
        finish({
          manifestDigest: input.request.manifestDigest,
          promotionId: input.request.promotionId,
          success: true,
        })
      })
      stdin.end(JSON.stringify(input.request))
    })
  } finally {
    await Promise.all([root.close(), draft.close()])
  }
}
