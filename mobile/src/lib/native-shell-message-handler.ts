import {
  isNativeShellPresentationMessage,
  nativeAttentionTotal,
} from '../components/native-shell-presentation'
import {
  isOpenExternalMessage,
} from './call-external-url'
import {
  isConnectorAuthorizationMessage,
} from './connector-authorization'
import { isHapticMessage } from './haptics'
import { isAuthGateRoute } from './native-shell-layout'
import type { HapticKind, NativeShellMessage } from './native-shell-message'
import { nativePushPathScript } from './native-shell'
import { tabIndexForPath, TABS } from './tabs'

type Input = {
  acknowledgePushPath: (path: string) => boolean
  acknowledgeExternalAuthDelivery: (id: number) => void
  currentPath: string | null
  currentPathRef: { current: string | null }
  dismissNativeMenus: () => void
  dismissNotifications: () => void
  dispatchPresentation: (message: NativeShellMessage) => void
  ensureNativePushRegistration: () => void
  flushExternalAuthDelivery: () => void
  markBooted: () => void
  noteBackState: (hasBackDepth: boolean) => void
  openConnectorAuthorization: (url: string) => void
  openExternalUrl: (url: string) => void
  reconcileNativeAttention: (total: number) => Promise<void>
  replayPendingPushPath: () => string | null
  runExternalAuth: (url: string, state?: string) => Promise<void>
  runScript: (script: string) => void
  setCurrentPath: (path: string) => void
  setIndex: (value: number | ((current: number) => number)) => void
  triggerHaptic: (kind: HapticKind) => void
}

/** Owns typed WebView-to-native bridge messages so the shell stays a layout. */
export const handleNativeShellMessage = (message: NativeShellMessage, input: Input): void => {
  if (isNativeShellPresentationMessage(message)) {
    input.dispatchPresentation(message)
    if (message.type === 'nessie:attention') {
      void input.reconcileNativeAttention(nativeAttentionTotal(message)).catch(() => undefined)
    }
    return
  }
  if (isOpenExternalMessage(message)) {
    input.openExternalUrl(message.url)
    return
  }
  if (isConnectorAuthorizationMessage(message)) {
    input.openConnectorAuthorization(message.authorizationUrl)
    return
  }
  if (message.type === 'nessie:external-auth' && typeof message.url === 'string') {
    void input.runExternalAuth(message.url, typeof message.state === 'string' ? message.state : undefined)
    return
  }
  if (message.type === 'nessie:external-auth-ready') {
    input.flushExternalAuthDelivery()
    return
  }
  if (message.type === 'nessie:external-auth-delivered' && typeof message.id === 'number') {
    input.acknowledgeExternalAuthDelivery(message.id)
    input.flushExternalAuthDelivery()
    return
  }
  if (message.type === 'nessie:request-push-registration') {
    const path = input.currentPathRef.current
    if (path && !isAuthGateRoute(path)) input.ensureNativePushRegistration()
    return
  }
  if (message.type === 'nessie:search-overlay') {
    if (message.active) {
      const searchIndex = TABS.findIndex((tab) => tab.key === 'search')
      if (searchIndex !== -1) input.setIndex(searchIndex)
    } else {
      input.setIndex(tabIndexForPath(input.currentPath ?? '/channels'))
    }
    return
  }
  if (message.type === 'nessie:transient-menu' && message.active) {
    input.dismissNativeMenus()
    return
  }
  if (message.type === 'nessie:back-state') {
    input.noteBackState(Boolean(message.hasBackDepth))
    return
  }
  if (isHapticMessage(message)) {
    input.triggerHaptic(message.haptic)
    return
  }
  if (message.type !== 'nessie:route' || typeof message.path !== 'string') return

  input.markBooted()
  input.currentPathRef.current = message.path
  input.dismissNotifications()
  input.setCurrentPath(message.path)
  const next = tabIndexForPath(message.path)
  input.setIndex((current) => (current === next ? current : next))
  if (input.acknowledgePushPath(message.path)) {
    input.runScript(nativePushPathScript(null))
  } else {
    input.replayPendingPushPath()
  }
  if (!isAuthGateRoute(message.path)) input.ensureNativePushRegistration()
}
