import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppState,
  Dimensions,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'
import {
  dismissNativeNotificationCards,
  getNativePushRegistration,
  reconcileNativeAttentionPresentation,
  subscribeToPushTokenChanges,
  type NativePushRegistration,
} from './src/lib/push-notifications'
import { useNativePushNavigation } from './src/lib/native-push-navigation'
import { useNativeBootRecovery } from './src/lib/use-native-boot-recovery'
import { useNativePhoneBack } from './src/lib/use-native-phone-back'
import { useNativeTheme } from './src/lib/use-native-theme'
import { nativeSelectTabScript } from './src/lib/native-phone-navigation'
import { allowsNativeBackForwardGestures } from './src/lib/webview-back-gesture'
import {
  createNativePushSurfaceClientId,
  nativeAppForegroundScript,
  nativePushPathScript,
  nativeShellInfoScript,
} from './src/lib/native-shell'
import { type NativeShellMessage } from './src/lib/native-shell-message'
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { INJECTED, isDark } from './src/lib/webview-inject'
import { statusBarStyleForNativePhoneHomeHeader } from './src/lib/status-bar'
import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  getIpadWindowedLeadingControlsClearance,
  isIpadWindowed,
  withOpacity,
} from './src/lib/ipad-native-chrome'
import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
} from './src/lib/android-tablet-dock'
import { AndroidTabletTabBar } from './src/components/AndroidTabletTabBar'
import {
  DEFAULT_TOOLBAR_STATE,
  type ToolbarState,
} from './src/components/IpadNativeToolbar'
import { IpadNativeChrome } from './src/components/IpadNativeChrome'
import {
  NativePhoneConversationMenuChrome,
} from './src/components/NativePhoneConversationMenuChrome'
import { IphoneNativeTabBar } from './src/components/IphoneNativeTabBar'
import { completeExternalAuth } from './src/lib/external-auth-session'
import { createNativeWebviewActions } from './src/lib/native-webview-actions'
import {
  createNativeTabNavigationState,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isFullScreenTaskRoute,
  isNativePhoneChannelsRootRoute,
  isNativePhoneTabRootRoute,
} from './src/lib/native-shell-layout'
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const { height: windowHeight, width: windowWidth } = useWindowDimensions()
  const theme = useNativeTheme()
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [ipadWorkspaceName, setIpadWorkspaceName] = useState<string | null>(null)
  const [nativeAccount, setNativeAccount] = useState({
    avatarUrl: null as string | null,
    name: null as string | null,
    presence: 'offline' as 'away' | 'offline' | 'online',
    statusEmoji: null as string | null,
  })
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE)
  const [attentionBadges, setAttentionBadges] = useState({ channels: 0, assignedWork: 0, knowledge: 0 })
  const currentPathRef = useRef<string | null>(null)
  const pushSurfaceClientId = useRef(createNativePushSurfaceClientId())
  const nativeAppForeground = useRef(AppState.currentState === 'active')
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(`${script} true;`)
  }, [])

  const nativeBackForwardGestures = allowsNativeBackForwardGestures({
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

  const runExternalAuth = async (authorizeUrl: string): Promise<void> => {
    const callbackUrl = await completeExternalAuth(authorizeUrl)
    if (callbackUrl) {
      const payload = JSON.stringify(callbackUrl)
      runScript(`window.__nessieExternalAuthCallback && window.__nessieExternalAuthCallback(${payload});`)
    }
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: NativeShellMessage
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    if (theme.applyMessage(msg)) return
    if (msg.type === 'nessie:account') {
      setNativeAccount({
        avatarUrl: typeof msg.userAvatarUrl === 'string' && msg.userAvatarUrl ? msg.userAvatarUrl : null,
        name: typeof msg.userName === 'string' && msg.userName.trim() ? msg.userName : null,
        presence: msg.userPresence === 'online' || msg.userPresence === 'away' ? msg.userPresence : 'offline',
        statusEmoji: typeof msg.userStatusEmoji === 'string' && msg.userStatusEmoji ? msg.userStatusEmoji : null,
      })
      return
    }
    if (msg.type === 'nessie:external-auth' && typeof msg.url === 'string') {
      void runExternalAuth(msg.url)
      return
    }
    if (msg.type === 'nessie:full-refresh') {
      bootRecovery.fullRefreshWebView()
      return
    }
    if (msg.type === 'nessie:request-push-registration') {
      const path = currentPathRef.current
      if (path && !isAuthGateRoute(path)) {
        ensureNativePushRegistration()
      }
      return
    }
    if (msg.type === 'nessie:attention') {
      const channels = typeof msg.channels === 'number' && msg.channels > 0 ? Math.floor(msg.channels) : 0
      const assignedWork = typeof msg.assignedWork === 'number' && msg.assignedWork > 0
        ? Math.floor(msg.assignedWork)
        : 0
      const knowledge = typeof msg.knowledge === 'number' && msg.knowledge > 0 ? Math.floor(msg.knowledge) : 0
      setAttentionBadges({ channels, assignedWork, knowledge })
      void reconcileNativeAttentionPresentation(
        typeof msg.total === 'number' && msg.total >= 0 ? msg.total : channels + assignedWork + knowledge,
      ).catch(() => undefined)
      return
    }
    if (msg.type === 'nessie:search-overlay') {
      if (msg.active) {
        const searchIndex = TABS.findIndex((tab) => tab.key === 'search')
        if (searchIndex !== -1) setIndex(searchIndex)
      } else {
        setIndex(tabIndexForPath(currentPath ?? '/channels'))
      }
      return
    }
    if (msg.type === 'nessie:toolbar-state') {
      setToolbarState({
        canBack: Boolean(msg.canBack),
        canForward: Boolean(msg.canForward),
        recentOpen: Boolean(msg.recentOpen),
      })
      return
    }
    if (msg.type === 'nessie:workspace') {
      setIpadWorkspaceName(typeof msg.name === 'string' && msg.name.trim() ? msg.name : null)
      return
    }
    if (msg.type === 'nessie:back-state') {
      // The admin's phone navigation bridge reports whether the current route
      // has an in-app parent; Android hardware Back consults the latest value.
      phoneBack.noteBackState(Boolean(msg.hasBackDepth))
      return
    }
    if (msg.type === 'nessie:route' && typeof msg.path === 'string') {
      // The admin only emits this once React has mounted, so it doubles as the
      // "booted" signal that defuses the blank-screen watchdog.
      bootRecovery.markBooted()
      currentPathRef.current = msg.path
      void dismissNativeNotificationCards().catch(() => undefined)
      setCurrentPath(msg.path)
      const next = tabIndexForPath(msg.path)
      setIndex((current) => (current === next ? current : next))
      if (acknowledgePushPath(msg.path)) {
        runScript(nativePushPathScript(null))
      } else {
        replayPendingPushPath()
      }
      if (!isAuthGateRoute(msg.path)) {
        ensureNativePushRegistration()
      }
    }
  }

  const onIndexChange = (next: number): void => {
    setIndex(next)
    if (IS_IPAD && TABS[next]?.key === 'search') {
      nativeActions.openSearchOverlay()
      return
    }
    nativeActions.closeSearchOverlay()
    const tab = TABS[next]
    if (!tab) return
    if (IS_IPAD) {
      // Tablets keep their existing push navigation; only the phone shell
      // shares the admin's tab select/reselect ledger.
      navigateTo(tab.path)
      return
    }
    runScript(nativeSelectTabScript(tab.path))
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath) && !isFullScreenTaskRoute(currentPath)
  const showNativePhoneHomeChrome = showBar && !IS_IPAD && isNativePhoneTabRootRoute(currentPath)
  const showNativePhoneCreationActions = showNativePhoneHomeChrome && isNativePhoneChannelsRootRoute(currentPath)

  // The native frame owns all unsafe edges. In particular, a phone tab root is
  // not always a direct aside/main child in the web DOM, so relying on injected
  // CSS can leave its first row beneath the status bar.
  const ipadChromeTop = getIpadChromeTop(insets.top)
  const screenDimensions = Dimensions.get('screen')
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
    showNativePhoneHomeHeader: showNativePhoneHomeChrome,
    showTabBar: showBar,
  })
  const webviewLayerStyle = {
    ...styles.webviewLayer,
    top: webviewInsets.top,
    bottom: webviewInsets.bottom,
  }
  const ipadChromeTheme = createIpadNativeChromeTheme({
    activeTintColor: theme.accent,
    dark: theme.dark,
    inactiveTintColor: theme.inactive,
    surfaceColor: theme.ipadChromeSurface,
  })
  const navigationState = createNativeTabNavigationState(index, attentionBadges)

  return (
    <View style={[styles.fill, { backgroundColor: theme.bg }]}>
      <StatusBar style={statusBarStyleForNativePhoneHomeHeader(
        showNativePhoneHomeChrome && isDark(theme.phoneHeaderSurface),
        theme.statusBarStyle,
      )} />

      {showBar && !IS_IPAD && !IS_ANDROID ? (
        <IphoneNativeTabBar
          activeTintColor={theme.accent}
          inactiveTintColor={theme.inactive}
          navigationState={navigationState}
          onIndexChange={onIndexChange}
        />
      ) : null}

      {showBar && IS_ANDROID ? (
        <AndroidTabletTabBar
          activeIndex={index}
          badgeCounts={attentionBadges}
          activeIndicatorColor={withOpacity(theme.accent, 0.14)}
          activeTintColor={theme.accent}
          bottom={insets.bottom + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP}
          dark={theme.dark}
          inactiveTintColor={theme.inactive}
          onIndexChange={onIndexChange}
          rippleColor={withOpacity(theme.accent, 0.18)}
        />
      ) : null}

      <View style={webviewLayerStyle}>
        {!initialPushPathResolved ? null : <WebView
          allowsBackForwardNavigationGestures={nativeBackForwardGestures}
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={nativeShellInfoScript({
            clientId: pushSurfaceClientId.current,
            formFactor: IS_IPAD ? 'ipad' : 'phone',
            pendingPushPath,
            platform: Platform.OS,
          })}
          injectedJavaScript={`${nativeShellInfoScript({
            clientId: pushSurfaceClientId.current,
            formFactor: IS_IPAD ? 'ipad' : 'phone',
            pendingPushPath,
            platform: Platform.OS,
          })}\n${INJECTED}\ntrue;`}
          key={bootRecovery.webviewKey}
          mediaPlaybackRequiresUserAction={false}
          onContentProcessDidTerminate={() => webRef.current?.reload()}
          onError={bootRecovery.recoverBlankWebView}
          onHttpError={bootRecovery.recoverBlankWebView}
          onLoadEnd={() => {
            runScript(nativeAppForegroundScript(nativeAppForeground.current))
            bootRecovery.noteLoadEnd()
          }}
          onLoadStart={bootRecovery.noteLoadStart}
          onMessage={onMessage}
          onRenderProcessGone={bootRecovery.remountWebView}
          originWhitelist={['*']}
          pullToRefreshEnabled
          ref={webRef}
          sharedCookiesEnabled
          source={{ uri: sourceUri }}
          style={[styles.fill, { backgroundColor: theme.bg }]}
        />}
      </View>

      {showNativePhoneHomeChrome ? (
        <NativePhoneConversationMenuChrome
          accentColor={theme.accent}
          accountAvatarUrl={nativeAccount.avatarUrl}
          accountName={nativeAccount.name}
          accountPresence={nativeAccount.presence}
          bottomInset={insets.bottom}
          creationAccentColor={theme.strongAccent}
          headerSurface={theme.phoneHeaderSurface}
          headerText={theme.phoneHeaderText}
          onAccentColor={theme.phoneOnAccent}
          onAccountPress={nativeActions.toggleAccountMenu}
          onCreateAction={nativeActions.createFromPhoneMenu}
          onHistoryPress={() => nativeActions.runToolbarAction('history')}
          onWorkspacePress={() => nativeActions.toggleWorkspaceMenu(insets.left + 16)}
          safeTop={insets.top}
          sheetMutedText={theme.phoneTextMuted}
          sheetText={theme.phoneText}
          sheetSurface={theme.ipadChromeSurface}
          platform={IS_ANDROID ? 'android' : 'ios'}
          showCreationActions={showNativePhoneCreationActions}
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
