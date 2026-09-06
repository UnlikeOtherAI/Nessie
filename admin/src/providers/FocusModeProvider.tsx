import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { useSessionMe, useUpdatePreferences } from '../facades/auth/hooks'
import { useAuthSession } from './AuthSessionProvider'

type FocusModeContextValue = {
  focusModeEnabled: boolean
  setFocusModeEnabled: (enabled: boolean) => void
  toggleFocusMode: () => void
  updating: boolean
}

const FocusModeContext = createContext<FocusModeContextValue | null>(null)

/**
 * Focus mode is a user preference rather than a client-only switch so all of a
 * person's Nessie surfaces agree to pause attention and remote push delivery.
 *
 * Keeping the devices in step is `useSessionMe()`'s job, not this provider's:
 * the query cache owns the cadence, the tab-visibility rule and the
 * cancellation that stops a late `/me` from reverting a local change.
 */
export const FocusModeProvider = ({ children }: PropsWithChildren) => {
  const { me } = useAuthSession()
  const updatePreferences = useUpdatePreferences()
  useSessionMe()
  const serverFocusModeEnabled = me?.user.preferences?.focusModeEnabled ?? false
  const [focusModeEnabled, setFocusModeEnabledState] = useState(serverFocusModeEnabled)

  useEffect(() => {
    setFocusModeEnabledState(serverFocusModeEnabled)
  }, [serverFocusModeEnabled])

  const setFocusModeEnabled = useCallback((enabled: boolean) => {
    const previous = focusModeEnabled
    setFocusModeEnabledState(enabled)
    updatePreferences.mutate(
      { focusModeEnabled: enabled },
      {
        onError: () => {
          setFocusModeEnabledState(previous)
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
