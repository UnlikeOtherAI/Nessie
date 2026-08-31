import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  AppState,
  Dimensions,
  Linking,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as ScreenOrientation from 'expo-screen-orientation'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView from 'react-native-webview'
import type { ShouldStartLoadRequest, WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes'
import { ADMIN_URL, CALL_JITSI_DOMAIN } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'
import {
  dismissNativeNotificationCards,
  getNativePushRegistration,
  reconcileNativeAttentionPresentation,
  subscribeToCallPushCancellation,
  subscribeToPushTokenChanges,
  type NativePushRegistration,
} from './src/lib/push-notifications'
import { useNativePushNavigation } from './src/lib/native-push-navigation'
import { useNativeBootRecovery } from './src/lib/use-native-boot-recovery'
import { useNativePhoneBack } from './src/lib/use-native-phone-back'
import { applyNativeTabIndexChange } from './src/lib/native-tab-index-change'
import { allowsNativeBackForwardGestures } from './src/lib/webview-back-gesture'
import {
  createNativePushSurfaceClientId,
  nativeAppForegroundScript,
  nativePhoneTabBarClearanceScript,
  nativePushPathScript,
  nativeShellInfoScript,
  wrapNativeWebViewScript,
} from './src/lib/native-shell'
import type { NativeShellMessage } from './src/lib/native-shell-message'
import { isDark } from './src/lib/webview-inject'
import { statusBarStyleForNativeBackdrop } from './src/lib/status-bar'
import { openAllowedCallExternalUrl, webViewNavigationDisposition } from './src/lib/call-external-url'
import { handleNativeShellMessage } from './src/lib/native-shell-message-handler'
import { isLandscape, supportsLargePhoneLandscape } from './src/lib/phone-orientation'
import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  getIpadWindowedLeadingControlsClearance,
  isIpadWindowed,
  withOpacity,
} from './src/lib/ipad-native-chrome'
import { ANDROID_TABLET_TAB_BAR_BOTTOM_GAP } from './src/lib/android-tablet-dock'
import { AndroidTabletTabBar } from './src/components/AndroidTabletTabBar'
import { IpadNativeChrome } from './src/components/IpadNativeChrome'
import { MobileAdminWebView } from './src/components/MobileAdminWebView'
import {
  NativePhoneConversationMenuChrome,
} from './src/components/NativePhoneConversationMenuChrome'
import { IphoneNativeTabBar } from './src/components/IphoneNativeTabBar'
import { completeExternalAuth } from './src/lib/external-auth-session'
import { createNativeExternalAuthDeliveryQueue, nativeExternalAuthDeliveryScript } from './src/lib/external-auth-delivery'
import { createNativeWebviewActions } from './src/lib/native-webview-actions'
import {
  DEFAULT_NATIVE_SHELL_PRESENTATION,
  reduceNativeShellPresentation,
} from './src/components/native-shell-presentation'
import {
  createNativeTabNavigationState,
  getNativePhoneHeaderHeight,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isFullScreenTaskRoute,
  isNativePhoneChannelsRootRoute,
  isNativePhoneTabRootRoute,
  shouldShowNativePhoneHeader,
} from './src/lib/native-shell-layout'
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const { height: windowHeight, width: windowWidth } = useWindowDimensions()
  const screenDimensions = Dimensions.get('screen')
  const largePhoneLandscapeCapable = supportsLargePhoneLandscape({
    height: screenDimensions.height,
    isPad: IS_IPAD,
    platform: Platform.OS,
    width: screenDimensions.width,
  })
  const largePhoneLandscape = largePhoneLandscapeCapable && isLandscape({
    height: windowHeight,
    width: windowWidth,
  })
  const nativeFormFactor = IS_IPAD ? 'ipad' : largePhoneLandscape ? 'large-phone-landscape' : 'phone'
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [presentation, dispatchPresentation] = useReducer(
    reduceNativeShellPresentation,
    DEFAULT_NATIVE_SHELL_PRESENTATION,
  )
  const [dismissCreationMenuVersion, dismissNativeMenus] = useReducer(
    (version: number) => version + 1,
    0,
  )
  const {
    accent,
    attentionBadges,
    background: bg,
    chromeSurface: ipadChromeSurface,
    inactive,
    nativeAccount,
    phoneHeaderSurface,
    phoneHeaderText,
    phoneOnAccent,
    phoneText,
    phoneTextMuted,
    statusBarStyle,
    strongAccent,
    toolbarState,
    workspaceAvatarUrl: nativeWorkspaceAvatarUrl,
    workspaceName: ipadWorkspaceName,
  } = presentation
  const currentPathRef = useRef<string | null>(null)
  const pushSurfaceClientId = useRef(createNativePushSurfaceClientId())
  const nativeAppForeground = useRef(AppState.currentState === 'active')
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)
  const externalAuthDeliveries = useRef(createNativeExternalAuthDeliveryQueue())

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(wrapNativeWebViewScript(script))
  }, [])

  useEffect(() => {
    if (IS_IPAD || Platform.OS !== 'ios') return
    const orientation = largePhoneLandscapeCapable
      ? ScreenOrientation.unlockAsync()
      : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
    void orientation.catch(() => undefined)
  }, [largePhoneLandscapeCapable])

  useEffect(() => {
    if (IS_IPAD || Platform.OS !== 'ios') return
    runScript(nativePhoneTabBarClearanceScript(insets.bottom))
  }, [insets.bottom, runScript])

  const nativeBackForwardGestures = largePhoneLandscape || allowsNativeBackForwardGestures({
    heightDp: windowHeight,
    widthDp: windowWidth,
  })
  const bootRecovery = useNativeBootRecovery(currentPathRef)
  const phoneBack = useNativePhoneBack(
    IS_ANDROID && !nativeBackForwardGestures,
    runScript,
  )

  const cachePushPath = useCallback((path: string): void => {
    runScript(nativePushPathScript(path))
  }, [runScript])
  const {
    acknowledgePushPath,
    initialPushPathResolved,
    pendingPushPath,
    replayPendingPushPath,
  } = useNativePushNavigation({
    cachePushPath,
  })

  // Orientation changes keep the WebView mounted. Re-publish the shell shape
  // so the hosted admin switches between the phone stack and fixed two-column
  // layout without relying on a reload.
  useEffect(() => {
    runScript(nativeShellInfoScript({
      bottomInset: insets.bottom,
      clientId: pushSurfaceClientId.current,
      formFactor: nativeFormFactor,
      pendingPushPath,
      platform: Platform.OS,
    }))
  }, [insets.bottom, nativeFormFactor, pendingPushPath, runScript])
  const sourceUri = bootRecovery.reloadNonce === 0
    ? ADMIN_URL
    : (() => {
      const url = new URL(bootRecovery.reloadPath ?? '/', ADMIN_URL)
      url.searchParams.set('__boot', String(bootRecovery.reloadNonce))
      return url.toString()
    })()

  const navigateTo = useCallback((path: string): void => {
    runScript(`window.__nessieNavigate && window.__nessieNavigate(${JSON.stringify(path)});`)
  }, [runScript])

  const sendNativePushRegistration = useCallback((registration: NativePushRegistration): void => {
    runScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_PUSH_TOKEN_EVENT)}, { detail: ${
        JSON.stringify(registration)
      } }));`,
    )
  }, [runScript])

  const publishNativePushRegistration = useCallback((registration: NativePushRegistration): void => {
    nativePushRegistration.current = registration
    const current = currentPathRef.current
    if (current && !isAuthGateRoute(current)) {
      sendNativePushRegistration(registration)
    }
  }, [sendNativePushRegistration])

  const ensureNativePushRegistration = (): void => {
    if (nativePushRegistration.current) {
      sendNativePushRegistration(nativePushRegistration.current)
      return
    }
    if (nativePushRegistrationPromise.current) {
      return
    }
    const registrationPromise = getNativePushRegistration()
    nativePushRegistrationPromise.current = registrationPromise
    void registrationPromise
      .then((registration) => {
        if (!registration) return
        publishNativePushRegistration(registration)
      })
      .catch(() => undefined)
      .finally(() => {
        if (nativePushRegistrationPromise.current === registrationPromise) {
          nativePushRegistrationPromise.current = null
        }
      })
  }

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
  }, [])

  useEffect(
    () => subscribeToPushTokenChanges(publishNativePushRegistration),
    [publishNativePushRegistration],
  )

  useEffect(() => subscribeToCallPushCancellation(), [])

  // WKWebView does not reliably emit `visibilitychange` while React Native is
  // backgrounding the app. Tell the hosted admin explicitly so it clears its
  // page-aware push target before iOS suspends the WebView.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      nativeAppForeground.current = nextState === 'active'
      runScript(nativeAppForegroundScript(nativeAppForeground.current))
      if (nativeAppForeground.current) {
        void dismissNativeNotificationCards().catch(() => undefined)
      }
    })
    return () => subscription.remove()
  }, [runScript])

  const nativeActions = createNativeWebviewActions(runScript)

  const flushExternalAuthDelivery = (): void => {
    const delivery = externalAuthDeliveries.current.head()
    if (delivery) runScript(nativeExternalAuthDeliveryScript(delivery))
  }

  const runExternalAuth = async (authorizeUrl: string, state?: string): Promise<void> => {
    const terminal = await completeExternalAuth(authorizeUrl, state)
    externalAuthDeliveries.current.enqueue(terminal.callbackUrl)
    flushExternalAuthDelivery()
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: NativeShellMessage
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    if (msg.type === 'nessie:full-refresh') {
      bootRecovery.fullRefreshWebView()
      return
    }
    handleNativeShellMessage(msg, {
      acknowledgeExternalAuthDelivery: (id) => externalAuthDeliveries.current.acknowledge(id),
      acknowledgePushPath,
      currentPath,
      currentPathRef,
      dismissNativeMenus,
      dismissNotifications: () => void dismissNativeNotificationCards().catch(() => undefined),
      dispatchPresentation,
      ensureNativePushRegistration,
      flushExternalAuthDelivery,
      markBooted: bootRecovery.markBooted,
      noteBackState: phoneBack.noteBackState,
      openExternalUrl: (url) => openAllowedCallExternalUrl(url, { jitsiDomain: CALL_JITSI_DOMAIN }, Linking.openURL),
      reconcileNativeAttention: async (total) => reconcileNativeAttentionPresentation(total),
      replayPendingPushPath,
      runExternalAuth,
      runScript,
      setCurrentPath,
      setIndex,
    })
  }

  const onIndexChange = (next: number): void => applyNativeTabIndexChange({
    closeSearchOverlay: nativeActions.closeSearchOverlay,
    closeTransientMenus: nativeActions.closeTransientMenus,
    dismissNativeMenus,
    isIpad: IS_IPAD,
    navigateTo,
    next,
    openSearchOverlay: nativeActions.openSearchOverlay,
    runScript,
    setIndex,
  })

  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest): boolean => {
    const disposition = webViewNavigationDisposition(request, {
      adminUrl: ADMIN_URL,
      jitsiDomain: CALL_JITSI_DOMAIN,
    })
    if (disposition === 'externalize') {
      openAllowedCallExternalUrl(request.url, { jitsiDomain: CALL_JITSI_DOMAIN }, Linking.openURL)
    } else if (disposition === 'block') {
      console.warn('[mobile] blocked top-level WebView navigation outside Nessie')
    }
    return disposition === 'allow'
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath) && !isFullScreenTaskRoute(currentPath)
  const showNativePhoneHeader = shouldShowNativePhoneHeader({
    isIpad: IS_IPAD,
    largePhoneLandscape,
    path: currentPath,
    showBar,
  })
  const showNativePhoneCreationActions = showNativePhoneHeader
    && isNativePhoneTabRootRoute(currentPath)
    && isNativePhoneChannelsRootRoute(currentPath)

  // The native frame owns all unsafe edges. In particular, a phone tab root is
  // not always a direct aside/main child in the web DOM, so relying on injected
  // CSS can leave its first row beneath the status bar.
  const ipadChromeTop = getIpadChromeTop(insets.top)
  const ipadLeadingControlsClearance = getIpadWindowedLeadingControlsClearance(
    IS_IPAD && isIpadWindowed({
      screenHeight: screenDimensions.height,
      screenWidth: screenDimensions.width,
      windowHeight,
      windowWidth,
    }),
  )
  const webviewInsets = getNativeWebviewFrameInsets({
    ipadChromeTop,
    isIpad: IS_IPAD,
    platform: Platform.OS,
    safeArea: insets,
    nativePhoneHeaderHeight: getNativePhoneHeaderHeight(largePhoneLandscape),
    showNativePhoneHeader,
    showTabBar: showBar,
  })
  const webviewLayerStyle = { ...styles.webviewLayer, top: webviewInsets.top, bottom: webviewInsets.bottom }
  const ipadChromeTheme = createIpadNativeChromeTheme({
    activeTintColor: accent,
    dark: isDark(bg),
    inactiveTintColor: inactive,
    surfaceColor: ipadChromeSurface,
  })
  const navigationState = createNativeTabNavigationState(index, attentionBadges)
  const hasNativeStatusBackdrop = showNativePhoneHeader || (IS_IPAD && showBar)
  const nativeStatusBackdropIsDark = showNativePhoneHeader
    ? isDark(phoneHeaderSurface)
    : isDark(bg)

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={statusBarStyleForNativeBackdrop(
        hasNativeStatusBackdrop,
        nativeStatusBackdropIsDark,
        statusBarStyle,
      )} />

      {showBar && IS_ANDROID ? (
        <AndroidTabletTabBar
          activeIndex={index}
          badgeCounts={attentionBadges}
          activeIndicatorColor={withOpacity(accent, 0.14)}
          activeTintColor={accent}
          bottom={insets.bottom + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP}
          dark={isDark(bg)}
          inactiveTintColor={inactive}
          onIndexChange={onIndexChange}
          rippleColor={withOpacity(accent, 0.18)}
        />
      ) : null}

      <View style={webviewLayerStyle}>
        <MobileAdminWebView
          backgroundColor={bg}
          bottomInset={insets.bottom}
          formFactor={nativeFormFactor}
          initialPushPathResolved={initialPushPathResolved}
          nativeAppForeground={nativeAppForeground}
          nativeBackForwardGestures={nativeBackForwardGestures}
          onError={bootRecovery.recoverBlankWebView}
          onHttpError={bootRecovery.recoverBlankWebView}
          onLoadEnd={() => { flushExternalAuthDelivery(); bootRecovery.noteLoadEnd() }}
          onLoadStart={bootRecovery.noteLoadStart}
          onMessage={onMessage}
          onRenderProcessGone={bootRecovery.remountWebView}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          pendingPushPath={pendingPushPath}
          platform={Platform.OS}
          pushSurfaceClientId={pushSurfaceClientId.current}
          runScript={runScript}
          sourceUri={sourceUri}
          webRef={webRef}
          webviewKey={bootRecovery.webviewKey}
        />
      </View>

      {showBar && !IS_IPAD && !IS_ANDROID ? (
        <IphoneNativeTabBar
          activeTintColor={accent}
          bottomInset={insets.bottom}
          inactiveTintColor={inactive}
          navigationState={navigationState}
          onIndexChange={onIndexChange}
        />
      ) : null}

      {showNativePhoneHeader ? (
        <NativePhoneConversationMenuChrome
          accentColor={accent}
          accountAvatarUrl={nativeAccount.avatarUrl}
          accountFocusModeEnabled={nativeAccount.focusModeEnabled}
          accountName={nativeAccount.name}
          accountPresence={nativeAccount.presence}
          bottomInset={insets.bottom}
          creationAccentColor={strongAccent}
          dismissCreationMenuVersion={dismissCreationMenuVersion}
          headerSurface={phoneHeaderSurface}
          headerText={phoneHeaderText}
          landscape={largePhoneLandscape}
          onAccentColor={phoneOnAccent}
          onAccountPress={nativeActions.toggleAccountMenu}
          onCreationMenuOpen={nativeActions.closeTransientMenus}
          onCreateAction={nativeActions.createFromPhoneMenu}
          onToolbarAction={nativeActions.runToolbarAction}
          onWorkspacePress={() => nativeActions.toggleWorkspaceMenu(insets.left + 16)}
          safeTop={insets.top}
          sheetMutedText={phoneTextMuted}
          sheetText={phoneText}
          sheetSurface={ipadChromeSurface}
          platform={IS_ANDROID ? 'android' : 'ios'}
          showCreationActions={showNativePhoneCreationActions}
          toolbarState={toolbarState}
          workspaceAvatarUrl={nativeWorkspaceAvatarUrl}
          workspaceName={ipadWorkspaceName}
        />
      ) : null}

      {showBar && IS_IPAD ? (
        <IpadNativeChrome
          activeIndex={index}
          account={nativeAccount}
          badgeCounts={attentionBadges}
          onIndexChange={onIndexChange}
          onToggleAccountMenu={nativeActions.toggleAccountMenu}
          onToggleWorkspaceMenu={nativeActions.toggleWorkspaceMenu}
          onToolbarAction={nativeActions.runToolbarAction}
          insetLeft={insets.left}
          insetRight={insets.right}
          leadingReservedWidth={ipadLeadingControlsClearance}
          theme={ipadChromeTheme}
          toolbarState={toolbarState}
          top={ipadChromeTop}
          windowWidth={windowWidth}
          workspaceAvatarUrl={nativeWorkspaceAvatarUrl}
          workspaceName={ipadWorkspaceName}
        />
      ) : null}
    </View>
  )
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webviewLayer: { position: 'absolute', right: 0, left: 0 },
})
