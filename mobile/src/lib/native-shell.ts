import { IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'

type NativeShellInfo = {
  bottomInset: number
  clientId: string
  formFactor: 'ipad' | 'phone'
  platform: string
  pendingPushPath: string | null
}

export const createNativePushSurfaceClientId = (): string => {
  const fragment = (): string => Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, '0')
  const random = `${fragment()}${fragment()}${fragment()}${fragment()}`
  return `${random.slice(0, 8)}-${random.slice(8, 12)}-4${random.slice(13, 16)}-8${random.slice(17, 20)}-${random.slice(20, 32)}`
}

export const nativeShellInfoScript = (info: NativeShellInfo): string => `
window.__nessieNativeShell = { bottomInset: ${JSON.stringify(info.bottomInset)}, platform: ${
  JSON.stringify(info.platform)
}, formFactor: ${JSON.stringify(info.formFactor)} };
window.__nessieNativeAppForeground = true;
window.__nessiePushSurfaceClientId = ${JSON.stringify(info.clientId)};
${info.pendingPushPath ? `window.__nessiePendingPushPath = ${JSON.stringify(info.pendingPushPath)};` : ''}
try { window.dispatchEvent(new Event('nessie:native-shell-info')); } catch (e) {}
${info.pendingPushPath ? `try {
  window.dispatchEvent(new CustomEvent('nessie:native-push-path', {
    detail: ${JSON.stringify(info.pendingPushPath)},
  }));
} catch (e) {}` : ''}
true;
`

export const nativePhoneTabBarClearanceScript = (bottomInset: number): string => {
  const safeBottomInset = Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0
  return `
try {
  document.documentElement.style.setProperty(
    '--nessie-native-phone-tabbar-clearance',
    ${JSON.stringify(`${IPHONE_TAB_BAR_HEIGHT + safeBottomInset}px`)},
  );
} catch (e) {}
`
}

/**
 * The WebView can be alive while its React application is still mounting. Keep
 * the notification route on `window` as well as emitting the event: the React
 * bridge reads the cached value when it becomes ready, rather than losing a
 * one-shot injected navigation call during startup.
 */
export const nativePushPathScript = (path: string | null): string => path
  ? `
window.__nessiePendingPushPath = ${JSON.stringify(path)};
// A warm notification tap can arrive while React is replacing an effect. Drive
// the installed navigator synchronously when it exists; the retained value and
// event below remain the cold-start and remount fallback.
try {
  if (typeof window.__nessieNavigate === 'function') {
    window.__nessieNavigate(${JSON.stringify(path)});
  }
} catch (e) {}
try {
  window.dispatchEvent(new CustomEvent('nessie:native-push-path', {
    detail: ${JSON.stringify(path)},
  }));
} catch (e) {}
`
  : `delete window.__nessiePendingPushPath;`

export const nativeAppForegroundScript = (foreground: boolean): string => `
window.__nessieNativeAppForeground = ${JSON.stringify(foreground)};
try {
  window.dispatchEvent(new CustomEvent('nessie:native-app-foreground', {
    detail: ${JSON.stringify(foreground)},
  }));
} catch (e) {}
`
