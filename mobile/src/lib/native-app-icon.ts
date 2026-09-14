import type { AppIconVariant } from '../../modules/nessie-app-icon'
import type { NativeShellMessage } from './native-shell-message'

/**
 * The WebView half of the Home Screen icon choice.
 *
 * The admin's Appearance settings own the control; the native side owns the
 * icon. One message crosses in (`nessie:app-icon`), and the icon actually in
 * effect crosses back — after iOS has applied it, or unchanged if it refused.
 */

export const NATIVE_APP_ICON_EVENT = 'nessie:native-app-icon'

export type AppIconMessage = NativeShellMessage & {
  type: 'nessie:app-icon'
  icon: AppIconVariant
}

export const isAppIconMessage = (message: NativeShellMessage): message is AppIconMessage =>
  message.type === 'nessie:app-icon' && (message.icon === 'light' || message.icon === 'dark')

/** Publishes the icon in effect, retained on `window` for a page that mounts later. */
export const nativeAppIconScript = (icon: AppIconVariant): string => `
try {
  window.__nessieNativeAppIcon = ${JSON.stringify(icon)};
  window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_APP_ICON_EVENT)}, {
    detail: ${JSON.stringify(icon)},
  }));
} catch (e) {}
`
