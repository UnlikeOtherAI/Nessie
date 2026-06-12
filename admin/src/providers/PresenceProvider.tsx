import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { PresenceEntry, PresenceManualState, PresenceState } from '../lib/api-client'
import { usePresenceList, useSetManualPresence } from '../facades/presence/hooks'
import { useApiClient } from './ApiClientProvider'
import { useAuthSession } from './AuthSessionProvider'

// What an avatar needs to badge a user: their live dot state plus the emoji /
// label of their active custom status (if any).
export type PresenceView = {
  state: PresenceState
  statusEmoji: string | null
  statusLabel: string | null
}

export type SelfPresence = {
  state: PresenceState
  manual: PresenceManualState | null
  setManual: (state: PresenceManualState | null) => void
  pending: boolean
}

type PresenceContextValue = {
  getPresence: (userId: string) => PresenceView
  self: SelfPresence
}

const PresenceContext = createContext<PresenceContextValue | null>(null)

const OFFLINE_VIEW: PresenceView = { state: 'offline', statusEmoji: null, statusLabel: null }
const IDLE_AFTER_MS = 5 * 60_000
const HEARTBEAT_MS = 25_000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

// The current user's own state, derived locally for instant feedback: offline
// when the network drops, away when the tab is hidden or idle, else online.
const computeLocalState = (lastActivityAt: number): PresenceState => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline'
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 'away'
  if (Date.now() - lastActivityAt > IDLE_AFTER_MS) return 'away'
  return 'online'
}

export const PresenceProvider = ({ children }: { children: ReactNode }) => {
  const { me, token } = useAuthSession()
  const apiClient = useApiClient()
  const enabled = Boolean(me && token)
  const selfUserId = me?.user.id ?? null

  const presenceQuery = usePresenceList(enabled)
  const setManualMutation = useSetManualPresence()

  const lastActivityRef = useRef(Date.now())
  const [localState, setLocalState] = useState<PresenceState>('online')
  const localStateRef = useRef<PresenceState>('online')
  localStateRef.current = localState

  // Optimistic manual override so the dot flips the instant the user toggles it,
  // before the poll catches up; reconciled to `undefined` once the server agrees.
  const [localManual, setLocalManual] = useState<PresenceManualState | null | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return undefined
    const recompute = () => setLocalState(computeLocalState(lastActivityRef.current))
    const onActivity = () => {
      lastActivityRef.current = Date.now()
      recompute()
    }
    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, onActivity, { passive: true }),
    )
    document.addEventListener('visibilitychange', recompute)
    window.addEventListener('online', recompute)
    window.addEventListener('offline', recompute)
    const interval = window.setInterval(recompute, 15_000)
    recompute()
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, onActivity))
      document.removeEventListener('visibilitychange', recompute)
      window.removeEventListener('online', recompute)
      window.removeEventListener('offline', recompute)
      window.clearInterval(interval)
    }
  }, [enabled])

  // Keepalive heartbeat (drives offline/online for everyone else).
  useEffect(() => {
    if (!enabled) return undefined
    const id = window.setInterval(() => {
      void apiClient
        .post('/api/presence/heartbeat', { active: localStateRef.current === 'online' })
        .catch(() => undefined)
    }, HEARTBEAT_MS)
    return () => window.clearInterval(id)
  }, [enabled, apiClient])

  // Immediate heartbeat on every local-state transition (incl. mount).
  useEffect(() => {
    if (!enabled) return
    void apiClient
      .post('/api/presence/heartbeat', { active: localState === 'online' })
      .catch(() => undefined)
  }, [localState, enabled, apiClient])

  const presenceMap = useMemo(() => {
    const map = new Map<string, PresenceEntry>()
    for (const entry of presenceQuery.data?.users ?? []) {
      map.set(entry.userId, entry)
    }
    return map
  }, [presenceQuery.data])

  const selfServerEntry = selfUserId ? presenceMap.get(selfUserId) : undefined
  const selfManual: PresenceManualState | null =
    localManual !== undefined ? localManual : selfServerEntry?.manualState ?? null

  // Drop the optimistic override once the polled value matches it.
  useEffect(() => {
    if (localManual !== undefined && (selfServerEntry?.manualState ?? null) === localManual) {
      setLocalManual(undefined)
    }
  }, [selfServerEntry, localManual])

  const selfState: PresenceState = useMemo(() => {
    if (localState === 'offline') return 'offline'
    if (selfManual === 'away') return 'away'
    if (selfManual === 'active') return 'online'
    return localState
  }, [localState, selfManual])

  const setManual = useCallback(
    (state: PresenceManualState | null) => {
      setLocalManual(state)
      setManualMutation.mutate(state)
    },
    [setManualMutation],
  )

  const getPresence = useCallback(
    (userId: string): PresenceView => {
      if (userId === selfUserId) {
        return {
          state: selfState,
          statusEmoji: selfServerEntry?.statusEmoji ?? null,
          statusLabel: selfServerEntry?.statusLabel ?? null,
        }
      }
      const entry = presenceMap.get(userId)
      return entry
        ? { state: entry.state, statusEmoji: entry.statusEmoji, statusLabel: entry.statusLabel }
        : OFFLINE_VIEW
    },
    [presenceMap, selfState, selfServerEntry, selfUserId],
  )

  const value = useMemo<PresenceContextValue>(
    () => ({
      getPresence,
      self: {
        state: selfState,
        manual: selfManual,
        setManual,
        pending: setManualMutation.isPending,
      },
    }),
    [getPresence, selfState, selfManual, setManual, setManualMutation.isPending],
  )

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
}

// A user's badge view, or `null` outside the provider / without a user id.
export const useUserPresence = (userId: string | null | undefined): PresenceView | null => {
  const ctx = useContext(PresenceContext)
  if (!ctx || !userId) return null
  return ctx.getPresence(userId)
}

// A lookup function for any user's presence/status view. Lets a list (e.g. the
// message feed) resolve many users' badges from a single hook call, instead of
// calling useUserPresence per row (which would violate the rules of hooks).
export const usePresenceLookup = (): ((userId: string | null | undefined) => PresenceView | null) => {
  const ctx = useContext(PresenceContext)
  return (userId) => (ctx && userId ? ctx.getPresence(userId) : null)
}

export const useSelfPresence = (): SelfPresence | null => {
  const ctx = useContext(PresenceContext)
  return ctx?.self ?? null
}
