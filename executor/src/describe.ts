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
 *
 * Host paths do appear, unlike in the descriptor: this answer stays on the
 * machine, and the person reading it is the person whose directories these are.
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
    /**
     * The folder names the last proposed revision names. Empty means the
     * descriptor predates named folders and stands for the single folder below.
     */
    workspaceFolders: string[]
  }
  reach: {
    /** HTTPS origins the guest browser may open; empty until one is configured. */
    allowedOrigins: string[]
    /**
     * The read-only host folders this executor is paired against, by the name
     * that starts every workspace path an agent writes.
     */
    folders: Array<{ name: string; path: string }>
    /**
     * Whether a guest VM session can start at all. A guest mounts one
     * workspace, so `command.run` and `coding.launch` refuse outright while
     * more than one folder is configured; see `guestSessionFolder`.
     */
    guestSessions: 'available' | 'refused_multiple_folders'
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
    workspaceFolders: [...(state.descriptor.workspaceFolders ?? [])],
  },
  reach: {
    allowedOrigins: [...(state.browserSandbox?.allowedOrigins ?? [])],
    folders: [...state.workspaceFolders]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((folder) => ({ name: folder.name, path: folder.path })),
    guestSessions: state.workspaceFolders.length === 1 ? 'available' : 'refused_multiple_folders',
  },
  sandbox: {
    browserConfigured: Boolean(state.browserSandbox),
    codingConfigured: Boolean(state.codexSandbox),
    promotionHelperConfigured: Boolean(state.nativeHelperPath),
  },
})
