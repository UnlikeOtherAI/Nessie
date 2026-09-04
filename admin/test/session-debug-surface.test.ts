import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('authenticated export and native login import reuse one session debug surface', () => {
  const exportButton = readSource('../src/components/shared/DebugTokenButton.tsx')
  const importButton = readSource('../src/components/shared/LoginSessionImportButton.tsx')
  const dialog = readSource('../src/components/shared/SessionDebugDialog.tsx')

  assert.match(exportButton, /SessionDebugDialog, SessionDebugIcon/)
  assert.match(importButton, /SessionDebugDialog, SessionDebugIcon/)
  assert.doesNotMatch(exportButton, /<svg/)
  assert.doesNotMatch(importButton, /<svg/)
  assert.match(dialog, /initialFocusRef: textareaRef/)
  assert.match(dialog, /kind: 'modal'/)
  assert.match(dialog, /aria-modal="true"/)
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /role="alert"/)
  assert.match(dialog, /style=\{actionMinWidth \? \{ minWidth: actionMinWidth \} : undefined\}/)
  assert.match(exportButton, /actionMinWidth="8\.5rem"/)
  assert.match(dialog, /\{\/\* Not the shared `Dialog`:/)
  assert.doesNotMatch(dialog, />\s*\/\/ Not the shared `Dialog`:/)
})

test('the import doorway is reachable from mobile and Linux login without forking the dialog', () => {
  const loginPage = readSource('../src/pages/LoginPage.tsx')
  const importButton = readSource('../src/components/shared/LoginSessionImportButton.tsx')

  assert.match(
    loginPage,
    /showMobileSessionImport = sessionState === 'unauthenticated' && isReactNativeWebView\(\)/,
  )
  assert.match(loginPage, /desktopPlatform\(\) === 'linux'/)
  assert.match(loginPage, /label="Use Windows session"/)
  assert.match(loginPage, /variant="inline"/)
  assert.match(loginPage, /LoginSessionImportButton onOpenChange=\{setSessionImportOpen\}/)
  assert.match(loginPage, /paddingRight: 'calc\(3\.5rem \+ env\(safe-area-inset-right, 0px\)\)'/)
  assert.match(importButton, /bottom: 'calc\(env\(safe-area-inset-bottom, 0px\) \+ 1rem\)'/)
  assert.match(importButton, /right: 'calc\(env\(safe-area-inset-right, 0px\) \+ 1rem\)'/)
  assert.match(importButton, /variant === 'floating'/)
  assert.match(importButton, /'fixed z-40 flex h-11 w-11/)
  assert.match(importButton, /'flex w-full items-center justify-center gap-2 rounded-2xl'/)
  assert.match(importButton, /setRawDump\(''\)/)
  assert.doesNotMatch(importButton, /!open \? \(/)
})

test('imported bearer sessions stay nonrenewable and never register native push', () => {
  const authProvider = readSource('../src/providers/AuthSessionProvider.tsx')
  const nativeBridge = readSource('../src/providers/NativeShellBridge.tsx')
  const renewal = readSource('../src/providers/useAccessTokenRenewal.ts')

  assert.match(authProvider, /sessionMutations\.run\(/)
  assert.match(authProvider, /resolveImportedSession\(accessToken, authApi\.fetchSession\)/)
  assert.match(authProvider, /storeToken\(payload\.token, imported \? 'imported' : 'renewable'\)/)
  assert.match(authProvider, /resolveSessionRefreshAction\(/)
  assert.match(authProvider, /importedMutationsInFlightRef\.current > 0/)
  assert.match(authProvider, /performTerminalSessionLogout\(/)
  assert.match(authProvider, /ending\.mode === 'imported'/)
  assert.match(authProvider, /IMPORTED_SESSION_SCOPE_MESSAGE/)
  assert.match(renewal, /getAccessTokenExpiresAtMs\(token\)/)
  assert.match(
    nativeBridge,
    /shouldRegisterNativePush\(isReactNativeWebView\(\), sessionMode\)/,
  )
  assert.match(nativeBridge, /Imported debug access is intentionally ephemeral/)
})
