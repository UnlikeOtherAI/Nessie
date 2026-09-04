/**
 * One live subscription for every dashboard currently mounted in the app.
 *
 * Conversation history can contain several cards and the side panel can show
 * one of them at the same time. Registering those ids here keeps that state on
 * one authenticated socket rather than opening a socket per card.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { useAgentRealtime } from '../../../facades/agents/realtime'
import type { RealtimeConnectionState } from '../../../facades/agents/keys'

type DashboardRealtimeApi = {
  connectionState: RealtimeConnectionState
  register: (dashboardId: string) => () => void
}

const DashboardRealtimeContext = createContext<DashboardRealtimeApi | null>(null)

export const DashboardRealtimeProvider = ({ children }: PropsWithChildren) => {
  const registrations = useRef(new Map<string, number>())
  const [dashboardIds, setDashboardIds] = useState<string[]>([])
  const register = useCallback((dashboardId: string) => {
    if (!dashboardId) return () => undefined
    const nextCount = (registrations.current.get(dashboardId) ?? 0) + 1
    registrations.current.set(dashboardId, nextCount)
    if (nextCount === 1) {
      setDashboardIds((current) => [...current, dashboardId].sort())
    }
    return () => {
      const count = registrations.current.get(dashboardId) ?? 0
      if (count <= 1) {
        registrations.current.delete(dashboardId)
        setDashboardIds((current) => current.filter((id) => id !== dashboardId))
      } else {
        registrations.current.set(dashboardId, count - 1)
      }
    }
  }, [])
  const realtime = useAgentRealtime({ dashboardIds })
  const value = useMemo<DashboardRealtimeApi>(
    () => ({ connectionState: realtime.connectionState, register }),
    [realtime.connectionState, register],
  )

  return (
    <DashboardRealtimeContext.Provider value={value}>
      {children}
    </DashboardRealtimeContext.Provider>
  )
}

/** Register a mounted card/panel with the shared socket and expose its state. */
export const useDashboardRealtime = (dashboardId: string | undefined): RealtimeConnectionState => {
  const context = useContext(DashboardRealtimeContext)
  const register = context?.register
  useEffect(() => {
    if (!register || !dashboardId) return undefined
    return register(dashboardId)
  }, [dashboardId, register])
  return context?.connectionState ?? 'disconnected'
}
