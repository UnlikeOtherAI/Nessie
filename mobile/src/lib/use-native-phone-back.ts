import { useCallback, useEffect, useRef } from 'react'
import { BackHandler } from 'react-native'
import { nativeBackScript, shouldConsumeNativeBack } from './native-phone-navigation'

type RunScript = (script: string) => void

export type NativePhoneBack = {
  // Record the latest `nessie:back-state` the admin posted for its route.
  noteBackState: (hasBackDepth: boolean) => void
}

// Android hardware Back on the native shell — installed on every Android form
// factor (`shouldInstallNativeBackHandler`), not only the phone one. The key
// is consumed — routed to the admin's shared Back decision via
// `window.__nessieNativeBack` — only when the LATEST back-state the page
// reported says the current route has an in-app parent. Otherwise the handler
// returns false and the platform default (background/exit) applies. iOS has
// no hardware Back key and never installs the listener.
export const useNativePhoneBack = (enabled: boolean, runScript: RunScript): NativePhoneBack => {
  const hasBackDepthRef = useRef(false)

  const noteBackState = useCallback((hasBackDepth: boolean): void => {
    hasBackDepthRef.current = hasBackDepth
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!shouldConsumeNativeBack(hasBackDepthRef.current)) return false
      runScript(nativeBackScript())
      return true
    })
    return () => subscription.remove()
  }, [enabled, runScript])

  return { noteBackState }
}
