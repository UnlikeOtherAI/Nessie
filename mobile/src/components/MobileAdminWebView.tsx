import type { RefObject } from 'react'
import WebView from 'react-native-webview'
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
} from 'react-native-webview/lib/WebViewTypes'
import { INJECTED } from '../lib/webview-inject'
import {
  nativeAppForegroundScript,
  nativeShellInfoScript,
  type NativeShellInfo,
  wrapNativeWebViewScript,
} from '../lib/native-shell'
import { isNativeVoiceCallAvailable } from '../../modules/nessie-voice-call'
import { NATIVE_BACK_FORWARD_GESTURES } from '../lib/webview-back-gesture'

type Props = {
  backgroundColor: string
  bottomInset: number
  formFactor: NativeShellInfo['formFactor']
  initialPushPathResolved: boolean
  nativeAppForeground: RefObject<boolean>
  onError: (event: WebViewErrorEvent) => void
  onHttpError: (event: WebViewHttpErrorEvent) => void
  onLoadEnd: () => void
  onLoadStart: () => void
  onMessage: (event: WebViewMessageEvent) => void
  onRenderProcessGone: () => void
  onShouldStartLoadWithRequest: (request: ShouldStartLoadRequest) => boolean
  pendingPushPath: string | null
  platform: string
  pushSurfaceClientId: string
  runScript: (script: string) => void
  sourceUri: string
  webRef: RefObject<WebView | null>
  webviewKey: number
}

/** The persistent admin WebView and the native safety boundary around its navigation. */
export const MobileAdminWebView = ({
  backgroundColor,
  bottomInset,
  formFactor,
  initialPushPathResolved,
  nativeAppForeground,
  onError,
  onHttpError,
  onLoadEnd,
  onLoadStart,
  onMessage,
  onRenderProcessGone,
  onShouldStartLoadWithRequest,
  pendingPushPath,
  platform,
  pushSurfaceClientId,
  runScript,
  sourceUri,
  webRef,
  webviewKey,
}: Props): React.JSX.Element | null => {
  if (!initialPushPathResolved) return null
  const shellInfo = {
    bottomInset,
    clientId: pushSurfaceClientId,
    formFactor,
    pendingPushPath,
    platform,
    voiceCall: isNativeVoiceCallAvailable(),
  }

  return (
    <WebView
      allowsBackForwardNavigationGestures={NATIVE_BACK_FORWARD_GESTURES}
      domStorageEnabled
      injectedJavaScriptBeforeContentLoaded={wrapNativeWebViewScript(nativeShellInfoScript(shellInfo))}
      injectedJavaScript={wrapNativeWebViewScript(`${nativeShellInfoScript(shellInfo)}\n${INJECTED}`)}
      key={webviewKey}
      // Calling the Personal Assistant captures audio in the WebView. Without
      // this the capture request is refused even once the OS has granted the
      // app microphone access, because WKWebView asks separately on the page's
      // behalf. Same-host only: the WebView's origin whitelist is open, so a
      // navigation away from the admin must not inherit the microphone.
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      mediaPlaybackRequiresUserAction={false}
      onContentProcessDidTerminate={() => webRef.current?.reload()}
      onError={onError}
      onHttpError={onHttpError}
      onLoadEnd={() => {
        runScript(nativeAppForegroundScript(nativeAppForeground.current))
        onLoadEnd()
      }}
      onLoadStart={onLoadStart}
      onMessage={onMessage}
      onRenderProcessGone={onRenderProcessGone}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      originWhitelist={['*']}
      // Pull-to-refresh is the web's (docs/navigation/overview.md §13): the WebView's
      // own gesture was iOS-only, forced bounces, reloaded the document from
      // any screen and told the page nothing. The admin owns the pull at the
      // top of a root or detail scroller and does a content-only refetch of the
      // visible page; the full WebView remount stays the "Full refresh" nav
      // button (nessie:full-refresh).
      pullToRefreshEnabled={false}
      ref={webRef}
      sharedCookiesEnabled
      source={{ uri: sourceUri }}
      style={{ flex: 1, backgroundColor }}
    />
  )
}
