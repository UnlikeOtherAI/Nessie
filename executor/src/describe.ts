import type { ExecutorLocalState } from './state-store.js'

/**
 * What this executor is allowed to reach and run, as one credential-free
 * answer. The menu bar app renders exactly this, and a headless operator reads
 * the same JSON over SSH — neither has to open the state file and neither
 * becomes a second interpretation of the policy.
 *
 * The machine key never appears here. It is the one field in the local state a
 * reader of this projection must never receive, so the shape is built field by
 * field rather than by removing keys from the state.
 */
export type ExecutorDescription = {
  apiBaseUrl: string
  executorId: string
  policy: {
    limits: ExecutorLocalState['descriptor']['limits']
    operations: string[]
    /** Empty means no program may start, not "no restriction". */
    permittedPrograms: string[]
    profiles: string[]
    revision: number
  }
  reach: {
    /** HTTPS origins the guest browser may open; empty until one is configured. */
    allowedOrigins: string[]
    /** The single read-only host directory this executor was paired against. */
    workspaceRoot: string
  }
  sandbox: {
    browserConfigured: boolean
    codingConfigured: boolean
    promotionHelperConfigured: boolean
  }
}

export const describeExecutor = (state: ExecutorLocalState): ExecutorDescription => ({
  apiBaseUrl: state.apiBaseUrl,
  executorId: state.executorId,
  policy: {
    limits: { ...state.descriptor.limits },
    operations: [...state.descriptor.operationKeys],
    permittedPrograms: [...(state.descriptor.commandAllowlist ?? [])],
    profiles: [...state.descriptor.profiles],
    revision: state.descriptor.revision,
  },
  reach: {
    allowedOrigins: [...(state.browserSandbox?.allowedOrigins ?? [])],
    workspaceRoot: state.workspaceRoot,
  },
  sandbox: {
    browserConfigured: Boolean(state.browserSandbox),
    codingConfigured: Boolean(state.codexSandbox),
    promotionHelperConfigured: Boolean(state.nativeHelperPath),
  },
})
