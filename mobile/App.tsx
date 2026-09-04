import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  Dimensions,
  Linking,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import * as Application from 'expo-application'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { StatusBar } from 'expo-status-bar'
import * as ScreenOrientation from 'expo-screen-orientation'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView from 'react-native-webview'
import type { ShouldStartLoadRequest, WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes'
import {
  ADMIN_URL,
  CALL_JITSI_DOMAIN,
  DIRECT_ANDROID_UPDATE_MANIFEST_URL,
  RELEASE_CHANNEL,
} from './src/config'
import {
  DIRECT_ANDROID_UPDATE_PREFERENCE_KEY,
  findDirectAndroidUpdate,
  parseDirectAndroidUpdatePreference,
  remindAboutDirectAndroidUpdateLater,
  skipDirectAndroidUpdate,
} from './src/lib/direct-android-updater'
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
import { shouldInstallNativeBackHandler } from './src/lib/native-phone-navigation'
import { applyNativeTabIndexChange } from './src/lib/native-tab-index-change'
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
import { openConnectorAuthorizationUrl } from './src/lib/connector-authorization'
import { triggerHaptic } from './src/lib/haptics'
import { handleNativeShellMessage } from './src/lib/native-shell-message-handler'
import {
  addNativeVoiceCallStateListener,
  endNativeVoiceCall,
  getActiveNativeVoiceCallState,
  isNativeVoiceCallAvailable,
  setNativeVoiceCallMuted,
  startNativeVoiceCall,
} from './modules/nessie-voice-call'
import { nativeVoiceCallStateScript } from './src/lib/native-voice-call'
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
import {
  createNativeExternalAuthDeliveryQueue,
  flushNativeExternalAuthDelivery,
} from './src/lib/external-auth-delivery'
import { createNativeWebviewActions } from './src/lib/native-webview-actions'
import {
  DEFAULT_NATIVE_SHELL_PRESENTATION,
  reduceNativeShellPresentation,
} from './src/components/native-shell-presentation'
import { useNativeFocusChrome } from './src/lib/use-native-focus-chrome'
import {
  createNativeTabNavigationState,
  DEFAULT_LAST_KNOWN_SCREEN,
  getNativePhoneHeaderHeight,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isFullScreenTaskRoute,
  type LastKnownScreen,
  shouldShowNativePhoneHeader,
} from './src/lib/native-shell-layout'
import { tabIndexForSection } from './src/lib/tabs'
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'

const checkForDirectAndroidUpdate = async (): Promise<void> => {
  if (!IS_ANDROID || RELEASE_CHANNEL !== 'direct') return
  const currentVersionCode = Number(Application.nativeBuildVersion)
  const storedPreference = await AsyncStorage
    .getItem(DIRECT_ANDROID_UPDATE_PREFERENCE_KEY)
    .catch(() => null)
  const update = await findDirectAndroidUpdate({
    channel: RELEASE_CHANNEL,
    currentVersionCode,
    fetchRelease: fetch,
    manifestUrl: DIRECT_ANDROID_UPDATE_MANIFEST_URL,
    now: Date.now(),
    preference: parseDirectAndroidUpdatePreference(storedPreference),
  })
  if (!update) return

  Alert.alert(
    'Update Nessie?',
    `Version ${update.version} is ready to download. Android will ask you to confirm the install.`,
    [
      {
        text: 'Skip this version',
        onPress: () => {
          void AsyncStorage.setItem(
            DIRECT_ANDROID_UPDATE_PREFERENCE_KEY,
            JSON.stringify(skipDirectAndroidUpdate(update.versionCode)),
          )
        },
      },
      {
        text: 'Remind me tomorrow',
        onPress: () => {
          void AsyncStorage.setItem(
            DIRECT_ANDROID_UPDATE_PREFERENCE_KEY,
            JSON.stringify(remindAboutDirectAndroidUpdateLater(update.versionCode, Date.now())),
          )
        },
      },
      {
        text: 'Update',
        onPress: () => {
          // Android owns the package-installer confirmation. Opening the
          // signed APK URL is the furthest an ordinary app can safely go.
          void Linking.openURL(update.url).catch(() => undefined)
        },
      },
    ],
  )
}

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
  const [index, setIndex] = useState(() => tabIndexForSection(DEFAULT_LAST_KNOWN_SCREEN.section))
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  // The shell's last-known picture of what the WebView is showing, built
  // entirely from `nessie:screen` messages (native-shell-message-handler.ts)
  // — never by matching `currentPath` against a copy of the admin's routing
  // table. `currentPath` above still tracks `nessie:route` for push-path
  // bookkeeping (boot recovery, notification/push registration), which is a
  // separate concern from tab selection and root-ness.
  const [lastKnownScreen, setLastKnownScreen] = useState<LastKnownScreen>(DEFAULT_LAST_KNOWN_SCREEN)
  // Once a `nessie:screen` message has arrived it is authoritative for
  // hardware Back consumption; a `nessie:back-state` kept around during the
  // admin's transition no longer overrides it (native-shell-message-handler.ts).
  const screenActiveRef = useRef(false)
  const [presentation, dispatchPresentation] = useReducer(
    reduceNativeShellPresentation,
    DEFAULT_NATIVE_SHELL_PRESENTATION,
  )
  const [dismissCreationMenuVersion, dismissNativeMenus] = useReducer(
    (version: number) => version + 1,
    0,
  )
  // Focus mode is monochrome, and the native header and tab bar are chrome the
  // page no longer draws, so they take that palette here rather than reading
  // it back out of the document -- travelling to it on the page's own 300ms
  // curve instead of snapping ahead of the surface behind them.
  const focusedPresentation = useNativeFocusChrome(presentation)
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
    teamAvatarUrl: nativeTeamAvatarUrl,
    teamName: ipadTeamName,
  } = focusedPresentation
  const currentPathRef = useRef<string | null>(null)
  const pushSurfaceClientId = useRef(createNativePushSurfaceClientId())
  const nativeAppForeground = useRef(AppState.currentState === 'active')
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)
  const externalAuthDeliveries = useRef(createNativeExternalAuthDeliveryQueue())

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(wrapNativeWebViewScript(script))
  }, [])

  // The call is native and survives a JS reload; the event stream does not.
  // Republishing the live state on every load is what stops a reload leaving
  // the admin blind while a call is running.
  useEffect(() => {
    if (!isNativeVoiceCallAvailable()) return undefined
    runScript(nativeVoiceCallStateScript(getActiveNativeVoiceCallState()))
    const subscription = addNativeVoiceCallStateListener((state) => {
      runScript(nativeVoiceCallStateScript(state))
    })
    return () => subscription?.remove()
  }, [runScript])

  const flushExternalAuthDelivery = useCallback((): void => {
    flushNativeExternalAuthDelivery(externalAuthDeliveries.current, runScript)
  }, [runScript])

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

  const bootRecovery = useNativeBootRecovery(currentPathRef)
  const phoneBack = useNativePhoneBack(
    shouldInstallNativeBackHandler(IS_ANDROID),
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
      voiceCall: isNativeVoiceCallAvailable(),
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

  // A direct APK can ask Android's package installer to replace it; store
  // builds are intentionally excluded by the build-time release channel.
  useEffect(() => {
    void checkForDirectAndroidUpdate()
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
        // ASWebAuthenticationSession may finish before WKWebView is ready to
        // execute injected JavaScript. The result stays in the native queue
        // until the SPA acknowledges it, so app activation is the exact event
        // that safely replays an unacknowledged callback.
        flushExternalAuthDelivery()
        void dismissNativeNotificationCards().catch(() => undefined)
      }
    })
    return () => subscription.remove()
  }, [flushExternalAuthDelivery, runScript])

  const nativeActions = createNativeWebviewActions(runScript)

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
      currentPathRef,
      dismissNativeMenus,
      dismissNotifications: () => void dismissNativeNotificationCards().catch(() => undefined),
      dispatchPresentation,
      ensureNativePushRegistration,
      flushExternalAuthDelivery,
      lastKnownScreen,
      markBooted: bootRecovery.markBooted,
      noteBackState: phoneBack.noteBackState,
      openConnectorAuthorization: (url) => openConnectorAuthorizationUrl(
        url,
        (targetUrl) => Linking.openURL(targetUrl),
      ),
      openExternalUrl: (url) => openAllowedCallExternalUrl(
        url,
        { jitsiDomain: CALL_JITSI_DOMAIN },
        (targetUrl) => Linking.openURL(targetUrl),
      ),
      reconcileNativeAttention: async (total) => reconcileNativeAttentionPresentation(total),
      replayPendingPushPath,
      endNativeVoiceCall: () => void endNativeVoiceCall().catch(() => undefined),
      runExternalAuth,
      runScript,
      setNativeVoiceCallMuted: (muted) => void setNativeVoiceCallMuted(muted).catch(() => undefined),
      startNativeVoiceCall: (provisioning) => void startNativeVoiceCall(provisioning)
        .catch(() => undefined),
      screenActiveRef,
      setCurrentPath,
      setIndex,
      setLastKnownScreen,
      triggerHaptic,
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
      openAllowedCallExternalUrl(
        request.url,
        { jitsiDomain: CALL_JITSI_DOMAIN },
        (targetUrl) => Linking.openURL(targetUrl),
      )
    } else if (disposition === 'block') {
      console.warn('[mobile] blocked top-level WebView navigation outside Nessie')
    }
    return disposition === 'allow'
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath) && !isFullScreenTaskRoute(currentPath)
  const isTabRoot = lastKnownScreen.type === 'root'
  const showNativePhoneHeader = shouldShowNativePhoneHeader({
    isIpad: IS_IPAD,
    isTabRoot,
    largePhoneLandscape,
    showBar,
  })
  const showNativePhoneCreationActions = showNativePhoneHeader
    && isTabRoot
    && lastKnownScreen.section === 'channels'

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
          onToggleFocusMode={nativeActions.toggleFocusMode}
          onCreationMenuOpen={nativeActions.closeTransientMenus}
          onCreateAction={nativeActions.createFromPhoneMenu}
          onToolbarAction={nativeActions.runToolbarAction}
          onTeamPress={() => nativeActions.toggleTeamMenu(insets.left + 16)}
          safeTop={insets.top}
          sheetMutedText={phoneTextMuted}
          sheetText={phoneText}
          sheetSurface={ipadChromeSurface}
          platform={IS_ANDROID ? 'android' : 'ios'}
          showCreationActions={showNativePhoneCreationActions}
          toolbarState={toolbarState}
          teamAvatarUrl={nativeTeamAvatarUrl}
          teamName={ipadTeamName}
        />
      ) : null}

      {showBar && IS_IPAD ? (
        <IpadNativeChrome
          activeIndex={index}
          account={nativeAccount}
          badgeCounts={attentionBadges}
          onIndexChange={onIndexChange}
          onToggleAccountMenu={nativeActions.toggleAccountMenu}
          onToggleFocusMode={nativeActions.toggleFocusMode}
          onToggleTeamMenu={nativeActions.toggleTeamMenu}
          onToolbarAction={nativeActions.runToolbarAction}
          insetLeft={insets.left}
          insetRight={insets.right}
          leadingReservedWidth={ipadLeadingControlsClearance}
          theme={ipadChromeTheme}
          toolbarState={toolbarState}
          top={ipadChromeTop}
          windowWidth={windowWidth}
          teamAvatarUrl={nativeTeamAvatarUrl}
          teamName={ipadTeamName}
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
