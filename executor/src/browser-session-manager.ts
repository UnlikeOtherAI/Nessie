import {
  ExecutorBrowserObserveArgumentsSchema,
  ExecutorBrowserOpenArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { assertExecutorEgressOrigin, compileExecutorEgressPolicy } from './egress-policy.js'
import { startGuestVmSession, type GuestVmSession, type GuestVmSessionInput } from './guest-vm-session.js'
import { createGuestWorkspaceLease, releaseGuestWorkspaceLease } from './guest-workspace-lease.js'
import type { ExecutorLocalState } from './state-store.js'

const BROWSER_SESSION_MAX_MS = 10 * 60 * 1_000

type ActiveBrowserSession = {
  session: GuestVmSession
  stopTimer: NodeJS.Timeout
}

type OpeningBrowserSession = {
  cancelled: boolean
  completed: Promise<void>
  finish: () => void
}

type BrowserSessionStarter = (input: GuestVmSessionInput) => Promise<GuestVmSession>

export type ExecutorBrowserSessionManager = {
  observe: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  open: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  stop: (runId: string) => Promise<boolean>
  stopAll: () => Promise<void>
}

const unavailable = (): Record<string, unknown> => ({
  code: 'EXECUTOR_BROWSER_UNAVAILABLE',
  success: false,
})

const denied = (): Record<string, unknown> => ({ code: 'EXECUTOR_BROWSER_DENIED', success: false })

/**
 * Holds only live guest processes. The durable server binding still authorizes
 * every command; this map solely preserves the VM that `browser.open` created
 * for a run so a separately bound `browser.observe` can inspect that same
 * browser. VM exit, explicit sandbox stop, daemon shutdown, and the bounded
 * lease timer all tear it down and release its exact COW lease.
 */
export const createExecutorBrowserSessionManager = (
  stateDir: string,
  state: ExecutorLocalState,
  dependencies: { startSession?: BrowserSessionStarter } = {},
): ExecutorBrowserSessionManager => {
  const activeByRun = new Map<string, ActiveBrowserSession>()
  const openedRunIds = new Set<string>()
  const openingByRun = new Map<string, OpeningBrowserSession>()
  const startSession = dependencies.startSession ?? startGuestVmSession

  const clear = (runId: string, active: ActiveBrowserSession): void => {
    if (activeByRun.get(runId) !== active) return
    clearTimeout(active.stopTimer)
    activeByRun.delete(runId)
  }

  const stop = async (runId: string): Promise<boolean> => {
    const opening = openingByRun.get(runId)
    if (opening) opening.cancelled = true
    const active = activeByRun.get(runId)
    if (!active) return Boolean(opening)
    await active.session.stop()
    clear(runId, active)
    return true
  }

  return {
    open: async (command, runId) => {
      const browserSandbox = state.browserSandbox
      if (!browserSandbox) return unavailable()
      if (openedRunIds.has(runId)) return { code: 'EXECUTOR_BROWSER_SESSION_USED', success: false }
      const maxSessions = state.descriptor.limits.maxSessions
      if (!Number.isInteger(maxSessions) || maxSessions < 1) return unavailable()
      if (activeByRun.size + openingByRun.size >= maxSessions) {
        return { code: 'EXECUTOR_BROWSER_CAPACITY_REACHED', success: false }
      }
      const args = ExecutorBrowserOpenArgumentsSchema.safeParse(command.payload.args)
      if (!args.success) return denied()
      let egress
      try {
        egress = compileExecutorEgressPolicy({ allowedOrigins: browserSandbox.allowedOrigins })
        assertExecutorEgressOrigin(args.data.url, egress)
      } catch {
        return denied()
      }
      openedRunIds.add(runId)
      let resolveOpening: (() => void) | undefined
      const opening: OpeningBrowserSession = {
        cancelled: false,
        completed: new Promise<void>((resolve) => { resolveOpening = resolve }),
        finish: () => resolveOpening?.(),
      }
      openingByRun.set(runId, opening)
      let lease: Awaited<ReturnType<typeof createGuestWorkspaceLease>> | undefined
      let session: GuestVmSession | undefined
      try {
        lease = await createGuestWorkspaceLease(stateDir, state.workspaceRoot, {
          bindingFence: command.bindingFence,
          commandId: command.commandId,
          runId,
        })
        session = await startSession({
          egressPolicy: { allowedOrigins: browserSandbox.allowedOrigins },
          guestInitrdBuilderPath: browserSandbox.guestInitrdBuilderPath,
          guestRuntimeBundlePath: browserSandbox.guestRuntimeBundlePath,
          kernelPath: browserSandbox.kernelPath,
          lease,
          stateDir,
          vmHelperPath: browserSandbox.vmHelperPath,
        })
        if (opening.cancelled || !(await session.inspectRuntime()).browser) {
          await session.stop()
          return unavailable()
        }
      } catch {
        await session?.stop().catch(() => undefined)
        if (lease) await releaseGuestWorkspaceLease(stateDir, lease).catch(() => undefined)
        return unavailable()
      } finally {
        if (openingByRun.get(runId) === opening) openingByRun.delete(runId)
        opening.finish()
      }
      if (!session || opening.cancelled) {
        await session?.stop().catch(() => undefined)
        return unavailable()
      }
      const active: ActiveBrowserSession = {
        session,
        stopTimer: setTimeout(() => { void stop(runId).catch(() => undefined) }, BROWSER_SESSION_MAX_MS),
      }
      activeByRun.set(runId, active)
      void session.closed.finally(() => clear(runId, active))
      if (opening.cancelled) {
        await stop(runId).catch(() => undefined)
        return unavailable()
      }
      try {
        await session.openBrowser(args.data.url)
      } catch {
        await stop(runId).catch(() => undefined)
        return unavailable()
      }
      return { status: 'opened', success: true }
    },
    observe: async (command, runId) => {
      if (!ExecutorBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) return denied()
      const active = activeByRun.get(runId)
      if (!active) return unavailable()
      try {
        const observation = await active.session.observeBrowser()
        return { success: true, targets: observation.targets }
      } catch {
        return unavailable()
      }
    },
    stop,
    stopAll: async () => {
      const opening = [...openingByRun.entries()]
      for (const [, entry] of opening) entry.cancelled = true
      await Promise.allSettled([
        ...[...activeByRun.keys()].map((runId) => stop(runId)),
        ...opening.map(([, entry]) => entry.completed),
      ])
    },
  }
}
