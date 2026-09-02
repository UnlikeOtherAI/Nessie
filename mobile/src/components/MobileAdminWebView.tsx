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

type Props = {
  backgroundColor: string
  bottomInset: number
  formFactor: NativeShellInfo['formFactor']
  initialPushPathResolved: boolean
  nativeAppForeground: RefObject<boolean>
  nativeBackForwardGestures: boolean
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
  nativeBackForwardGestures,
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
  }

  return (
    <WebView
      allowsBackForwardNavigationGestures={nativeBackForwardGestures}
      domStorageEnabled
      injectedJavaScriptBeforeContentLoaded={wrapNativeWebViewScript(nativeShellInfoScript(shellInfo))}
      injectedJavaScript={wrapNativeWebViewScript(`${nativeShellInfoScript(shellInfo)}\n${INJECTED}`)}
      key={webviewKey}
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
      // Pull-to-refresh is the web's (docs/navigation.md §13): the WebView's
      // own gesture was iOS-only, forced bounces, reloaded the document from
      // any screen and told the page nothing. The admin owns the pull at the
      // top of a root or detail scroller and posts nessie:full-refresh.
      pullToRefreshEnabled={false}
      ref={webRef}
      sharedCookiesEnabled
      source={{ uri: sourceUri }}
      style={{ flex: 1, backgroundColor }}
    />
  )
}
