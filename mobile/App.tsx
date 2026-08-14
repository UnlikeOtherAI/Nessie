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
import { startDevInspector } from './src/lib/dev-inspector'
import {
  dismissNativeNotificationCards,
  getNativePushRegistration,
  reconcileNativeAttentionPresentation,
  subscribeToPushTokenChanges,
  type NativePushRegistration,
} from './src/lib/push-notifications'
import { useNativePushNavigation } from './src/lib/native-push-navigation'
import {
  createNativePushSurfaceClientId,
  nativeAppForegroundScript,
  nativePushPathScript,
  nativeShellInfoScript,
} from './src/lib/native-shell'
import { type NativeShellMessage } from './src/lib/native-shell-message'
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { useWebviewBootRecovery } from './src/lib/use-webview-boot-recovery'
import { allowsNativeBackForwardGestures } from './src/lib/webview-back-gesture'
import { DEFAULT_BG, INJECTED, isDark, parseRgb } from './src/lib/webview-inject'
import {
  statusBarStyleForNativePhoneHomeHeader,
  statusBarStyleForScheme,
} from './src/lib/status-bar'
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
const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_STRONG_ACTIVE_TINT = '#5b21b6'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const DEFAULT_IPAD_CHROME_SURFACE = '#222629'
const DEFAULT_PHONE_HEADER_SURFACE = '#2b2018'
const DEFAULT_PHONE_HEADER_TEXT = '#fffdf8'
const DEFAULT_PHONE_TEXT = '#2b2018'
const DEFAULT_PHONE_TEXT_MUTED = '#74665b'


const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const { height: windowHeight, width: windowWidth } = useWindowDimensions()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [statusBarStyle, setStatusBarStyle] = useState<'light' | 'dark'>('light')
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [strongAccent, setStrongAccent] = useState(DEFAULT_STRONG_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [ipadChromeSurface, setIpadChromeSurface] = useState(DEFAULT_IPAD_CHROME_SURFACE)
  const [ipadWorkspaceName, setIpadWorkspaceName] = useState<string | null>(null)
  const [phoneHeaderSurface, setPhoneHeaderSurface] = useState(DEFAULT_PHONE_HEADER_SURFACE)
  const [phoneHeaderText, setPhoneHeaderText] = useState(DEFAULT_PHONE_HEADER_TEXT)
  const [phoneText, setPhoneText] = useState(DEFAULT_PHONE_TEXT)
  const [phoneTextMuted, setPhoneTextMuted] = useState(DEFAULT_PHONE_TEXT_MUTED)
  const [phoneOnAccent, setPhoneOnAccent] = useState(DEFAULT_PHONE_HEADER_TEXT)
  const [nativeAccount, setNativeAccount] = useState({
    avatarUrl: null as string | null,
    name: null as string | null,
    presence: 'offline' as 'away' | 'offline' | 'online',
    statusEmoji: null as string | null,
  })
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE)
  const [attentionBadges, setAttentionBadges] = useState({ channels: 0, assignedWork: 0, knowledge: 0 })
  const {
    fullRefreshWebView,
    noteAdminBooted,
    remountWebview,
    sourceUri,
    webviewBootProps,
  } = useWebviewBootRecovery()
  const currentPathRef = useRef<string | null>(null)
  const pushSurfaceClientId = useRef(createNativePushSurfaceClientId())
  const nativeAppForeground = useRef(AppState.currentState === 'active')
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(`${script} true;`)
  }, [])

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
    if (msg.type === 'bg' && typeof msg.color === 'string') {
      const rgb = parseRgb(msg.color)
      if (rgb && rgb[3] !== 0) setBg(msg.color)
      return
    }
    if (msg.type === 'theme') {
      if (typeof msg.accent === 'string' && msg.accent) setAccent(msg.accent)
      if (typeof msg.accentStrong === 'string' && msg.accentStrong) setStrongAccent(msg.accentStrong)
      if (typeof msg.inactive === 'string' && msg.inactive) setInactive(msg.inactive)
      if (typeof msg.surface === 'string' && msg.surface) setIpadChromeSurface(msg.surface)
      if (typeof msg.headerSurface === 'string' && msg.headerSurface) setPhoneHeaderSurface(msg.headerSurface)
      if (typeof msg.headerText === 'string' && msg.headerText) setPhoneHeaderText(msg.headerText)
      if (typeof msg.text === 'string' && msg.text) setPhoneText(msg.text)
      if (typeof msg.textMuted === 'string' && msg.textMuted) setPhoneTextMuted(msg.textMuted)
      if (typeof msg.onAccent === 'string' && msg.onAccent) setPhoneOnAccent(msg.onAccent)
      const nextStatusBarStyle = statusBarStyleForScheme(msg.scheme)
      if (nextStatusBarStyle) setStatusBarStyle(nextStatusBarStyle)
      return
    }
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
      fullRefreshWebView()
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
    if (msg.type === 'nessie:route' && typeof msg.path === 'string') {
      // The admin only emits this once React has mounted, so it doubles as the
      // "booted" signal that defuses the blank-screen watchdog.
      noteAdminBooted()
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
    navigateTo(TABS[next].path)
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
    activeTintColor: accent,
    dark: isDark(bg),
    inactiveTintColor: inactive,
    surfaceColor: ipadChromeSurface,
  })
  const navigationState = createNativeTabNavigationState(index, attentionBadges)

  // One interactive Back owner per layout: phones hand the edge swipe to the
  // admin's PhoneNavigationViewport, tablets keep the native WebView gesture.
  const webviewBackForwardGestures = allowsNativeBackForwardGestures({
    heightDp: windowHeight,
    widthDp: windowWidth,
  })

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={statusBarStyleForNativePhoneHomeHeader(
        showNativePhoneHomeChrome && isDark(phoneHeaderSurface),
        statusBarStyle,
      )} />

      {showBar && !IS_IPAD && !IS_ANDROID ? (
        <IphoneNativeTabBar
          activeTintColor={accent}
          inactiveTintColor={inactive}
          navigationState={navigationState}
          onIndexChange={onIndexChange}
        />
      ) : null}

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
        {!initialPushPathResolved ? null : <WebView
          allowsBackForwardNavigationGestures={webviewBackForwardGestures}
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
          mediaPlaybackRequiresUserAction={false}
          onContentProcessDidTerminate={() => webRef.current?.reload()}
          onLoadEnd={() => {
            runScript(nativeAppForegroundScript(nativeAppForeground.current))
            // Page finished loading; the hook's watchdog gives the admin a
            // window to report itself mounted before assuming the WebView is
            // blank/white.
            webviewBootProps.onLoadEnd()
          }}
          onMessage={onMessage}
          onRenderProcessGone={remountWebview}
          // The hook's stable props (remount key, recovery onError/onHttpError)
          // spread after every literal they replace, but onLoadEnd above must
          // keep running first: it posts the native foreground state through
          // nativeAppForegroundScript and only then arms the boot watchdog.
          {...webviewBootProps}
          originWhitelist={['*']}
          pullToRefreshEnabled
          ref={webRef}
          sharedCookiesEnabled
          source={{ uri: sourceUri }}
          style={[styles.fill, { backgroundColor: bg }]}
        />}
      </View>

      {showNativePhoneHomeChrome ? (
        <NativePhoneConversationMenuChrome
          accentColor={accent}
          accountAvatarUrl={nativeAccount.avatarUrl}
          accountName={nativeAccount.name}
          accountPresence={nativeAccount.presence}
          bottomInset={insets.bottom}
          creationAccentColor={strongAccent}
          headerSurface={phoneHeaderSurface}
          headerText={phoneHeaderText}
          onAccentColor={phoneOnAccent}
          onAccountPress={nativeActions.toggleAccountMenu}
          onCreateAction={nativeActions.createFromPhoneMenu}
          onHistoryPress={() => nativeActions.runToolbarAction('history')}
          onWorkspacePress={() => nativeActions.toggleWorkspaceMenu(insets.left + 16)}
          safeTop={insets.top}
          sheetMutedText={phoneTextMuted}
          sheetText={phoneText}
          sheetSurface={ipadChromeSurface}
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
