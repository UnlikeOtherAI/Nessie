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
import { isVoiceCallControlMessage, isVoiceCallStartMessage } from './native-voice-call'
import { isAuthGateRoute, type LastKnownScreen, type NativeScreenBar } from './native-shell-layout'
import { isScreenBarMessage, isScreenMessage } from './native-shell-message'
import type { NativeVoiceCallProvisioning } from '../../modules/nessie-voice-call'
import type { HapticKind, NativeShellMessage } from './native-shell-message'
import { nativePushPathScript } from './native-shell'
import { tabIndexForSection, TABS } from './tabs'

type Input = {
  acknowledgePushPath: (path: string) => boolean
  acknowledgeExternalAuthDelivery: (id: number) => void
  currentPathRef: { current: string | null }
  dismissNativeMenus: () => void
  dismissNotifications: () => void
  dispatchPresentation: (message: NativeShellMessage) => void
  ensureNativePushRegistration: () => void
  flushExternalAuthDelivery: () => void
  lastKnownScreen: LastKnownScreen
  markBooted: () => void
  noteBackState: (hasBackDepth: boolean) => void
  openConnectorAuthorization: (url: string) => void
  openExternalUrl: (url: string) => void
  reconcileNativeAttention: (total: number) => Promise<void>
  replayPendingPushPath: () => string | null
  runExternalAuth: (url: string, state?: string) => Promise<void>
  runScript: (script: string) => void
  setNativeVoiceCallMuted: (muted: boolean) => void
  startNativeVoiceCall: (provisioning: NativeVoiceCallProvisioning) => void
  endNativeVoiceCall: () => void
  screenActiveRef: { current: boolean }
  setCurrentPath: (path: string) => void
  setIndex: (value: number | ((current: number) => number)) => void
  setLastKnownScreen: (screen: LastKnownScreen) => void
  setScreenBar: (bar: NativeScreenBar | null) => void
  triggerHaptic: (kind: HapticKind) => void
}

/** Owns typed WebView-to-native bridge messages so the shell stays a layout. */
export const handleNativeShellMessage = (message: NativeShellMessage, input: Input): void => {
  if (isScreenBarMessage(message)) {
    input.setScreenBar({
      back: message.back ? { label: message.back.label } : null,
      layerKey: message.layerKey ?? null,
      title: message.title,
    })
    return
  }
  if (isScreenMessage(message)) {
    input.screenActiveRef.current = true
    input.setLastKnownScreen({
      depth: message.depth,
      hasBack: message.hasBack,
      section: message.section,
      title: message.title,
      type: message.screenType,
    })
    // nessie:screen supersedes nessie:back-state for hardware Back
    // consumption once it starts arriving — see the back-state branch below.
    input.noteBackState(message.hasBack)
    const next = tabIndexForSection(message.section)
    input.setIndex((current) => (current === next ? current : next))
    return
  }
  if (isNativeShellPresentationMessage(message)) {
    input.dispatchPresentation(message)
    if (message.type === 'nessie:attention') {
      void input.reconcileNativeAttention(nativeAttentionTotal(message)).catch(() => undefined)
    }
    return
  }
  // A call is native from the moment the button is pressed: the WebView hands
  // over the credential and never touches the call again, because a locked
  // phone suspends it.
  if (isVoiceCallStartMessage(message)) {
    input.startNativeVoiceCall(message.voiceCall)
    return
  }
  if (isVoiceCallControlMessage(message)) {
    if (message.type === 'nessie:voice-call-end') {
      input.endNativeVoiceCall()
    } else {
      input.setNativeVoiceCallMuted(message.muted === true)
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
      input.setIndex(tabIndexForSection(input.lastKnownScreen.section))
    }
    return
  }
  if (message.type === 'nessie:transient-menu' && message.active) {
    input.dismissNativeMenus()
    return
  }
  if (message.type === 'nessie:back-state') {
    // Once nessie:screen has started arriving it is authoritative for back
    // consumption; a plain nessie:back-state kept around during the
    // transition no longer overrides it.
    if (!input.screenActiveRef.current) input.noteBackState(Boolean(message.hasBackDepth))
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
  if (input.acknowledgePushPath(message.path)) {
    input.runScript(nativePushPathScript(null))
  } else {
    input.replayPendingPushPath()
  }
  if (!isAuthGateRoute(message.path)) input.ensureNativePushRegistration()
}
