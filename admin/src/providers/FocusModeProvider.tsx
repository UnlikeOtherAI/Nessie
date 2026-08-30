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
import type { MeResponse } from '@nessie/schemas'
import { useUpdatePreferences } from '../facades/auth/hooks'
import { useApiClient } from './ApiClientProvider'
import { useAuthSession } from './AuthSessionProvider'

type FocusModeContextValue = {
  focusModeEnabled: boolean
  setFocusModeEnabled: (enabled: boolean) => void
  toggleFocusMode: () => void
  updating: boolean
}

const FocusModeContext = createContext<FocusModeContextValue | null>(null)
const FOCUS_MODE_SYNC_INTERVAL_MS = 15_000

/**
 * Focus mode is a user preference rather than a client-only switch so all of a
 * person's Nessie surfaces agree to pause attention and remote push delivery.
 */
export const FocusModeProvider = ({ children }: PropsWithChildren) => {
  const apiClient = useApiClient()
  const { applyMeResponse, me } = useAuthSession()
  const updatePreferences = useUpdatePreferences()
  const serverFocusModeEnabled = me?.user.preferences?.focusModeEnabled ?? false
  const [focusModeEnabled, setFocusModeEnabledState] = useState(serverFocusModeEnabled)
  // A response that began before this device changed focus mode must never
  // overwrite the optimistic value while the PATCH is in flight.
  const localChangeVersion = useRef(0)
  const localChangeInFlight = useRef(false)

  useEffect(() => {
    setFocusModeEnabledState(serverFocusModeEnabled)
  }, [serverFocusModeEnabled])

  const refreshSharedFocusMode = useCallback(async (): Promise<void> => {
    const requestVersion = localChangeVersion.current
    try {
      const nextMe = await apiClient.get<MeResponse>('/api/auth/me')
      if (!localChangeInFlight.current && requestVersion === localChangeVersion.current) {
        applyMeResponse(nextMe)
      }
    } catch {
      // A later foreground event or polling pass reconciles after an offline
      // period. Keeping the last known server preference avoids a local flip.
    }
  }, [apiClient, applyMeResponse])

  useEffect(() => {
    if (!me) return undefined

    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshSharedFocusMode()
      }
    }
    const interval = window.setInterval(refreshIfVisible, FOCUS_MODE_SYNC_INTERVAL_MS)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [me?.user.id, refreshSharedFocusMode])

  const setFocusModeEnabled = useCallback((enabled: boolean) => {
    const previous = focusModeEnabled
    localChangeVersion.current += 1
    localChangeInFlight.current = true
    setFocusModeEnabledState(enabled)
    updatePreferences.mutate(
      { focusModeEnabled: enabled },
      {
        onError: () => {
          localChangeVersion.current += 1
          localChangeInFlight.current = false
          setFocusModeEnabledState(previous)
        },
        onSuccess: () => {
          // Discard an older GET that completed after the successful PATCH.
          localChangeVersion.current += 1
          localChangeInFlight.current = false
        },
      },
    )
  }, [focusModeEnabled, updatePreferences])

  const toggleFocusMode = useCallback(() => {
    setFocusModeEnabled(!focusModeEnabled)
  }, [focusModeEnabled, setFocusModeEnabled])

  const value = useMemo(
    () => ({
      focusModeEnabled,
      setFocusModeEnabled,
      toggleFocusMode,
      updating: updatePreferences.isPending,
    }),
    [focusModeEnabled, setFocusModeEnabled, toggleFocusMode, updatePreferences.isPending],
  )

  return <FocusModeContext.Provider value={value}>{children}</FocusModeContext.Provider>
}

export const useFocusMode = (): FocusModeContextValue => {
  const context = useContext(FocusModeContext)
  if (!context) {
    throw new Error('useFocusMode must be used within FocusModeProvider')
  }
  return context
}
