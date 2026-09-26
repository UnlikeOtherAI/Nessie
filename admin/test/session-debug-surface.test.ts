import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { buildSessionDebugDump } from '../src/lib/session-debug-export'
import { parseSessionDebugImport } from '../src/lib/session-debug-import'

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const BROWSER_GLOBALS = ['document', 'localStorage', 'window'] as const

const withBrowserGlobals = (dom: JSDOM, run: () => void): void => {
  const values = {
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    window: dom.window,
  }
  const originals = BROWSER_GLOBALS.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  for (const name of BROWSER_GLOBALS) {
    Object.defineProperty(globalThis, name, { configurable: true, value: values[name], writable: true })
  }
  try {
    run()
  } finally {
    BROWSER_GLOBALS.forEach((name, index) => {
      const original = originals[index]
      if (original) Object.defineProperty(globalThis, name, original)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
}

test('Session debug exports the dump the sign-in import reads back', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://nessie.test/admin/advanced/debug',
  })
  withBrowserGlobals(dom, () => {
    dom.window.localStorage.setItem('nessie.admin.token', 'header.payload.signature')
    const dump = buildSessionDebugDump(null)
    assert.deepEqual(parseSessionDebugImport(dump, 'https://nessie.test'), {
      accessToken: 'header.payload.signature',
    })
  })
})

test('the export is an Advanced page and the sign-in import keeps the one session debug dialog', () => {
  const page = readSource('../src/pages/admin/SessionDebugPage.tsx')
  const importButton = readSource('../src/components/shared/LoginSessionImportButton.tsx')
  const dialog = readSource('../src/components/shared/SessionDebugDialog.tsx')

  // The page reads the one dump builder rather than assembling the JSON itself.
  assert.match(page, /buildSessionDebugDump\(me\)/)
  assert.doesNotMatch(page, /loadStoredToken|document\.cookie/)
  assert.match(page, /fixedWidth: '10rem'/)
  assert.match(page, /eyebrow="Advanced"/)
  assert.match(page, /aria-label="Session debug JSON"/)
  assert.match(importButton, /SessionDebugDialog, SessionDebugIcon/)
  assert.doesNotMatch(importButton, /<svg/)
  assert.match(dialog, /initialFocusRef: textareaRef/)
  assert.match(dialog, /kind: 'modal'/)
  assert.match(dialog, /aria-modal="true"/)
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /role="alert"/)
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
  assert.match(loginPage, /paddingBottom: 'calc\(3\.5rem \+ env\(safe-area-inset-bottom, 0px\)\)'/)
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
  const nativeBridge = readSource('../src/bridges/NativeShellBridge.tsx')
  const renewal = readSource('../src/providers/useAccessTokenRenewal.ts')
  // The re-scoping refusal lives with the team switches it guards.
  const teamRecovery = readSource('../src/providers/useTeamSessionRecovery.ts')

  assert.match(authProvider, /sessionMutations\.run\(/)
  assert.match(authProvider, /resolveImportedSession\(accessToken, authApi\.fetchSession\)/)
  assert.match(authProvider, /storeToken\(payload\.token, imported \? 'imported' : 'renewable'\)/)
  assert.match(authProvider, /resolveSessionRefreshAction\(/)
  assert.match(authProvider, /importedMutationsInFlightRef\.current > 0/)
  assert.match(authProvider, /performTerminalSessionLogout\(/)
  assert.match(authProvider, /ending\.mode === 'imported'/)
  assert.match(teamRecovery, /IMPORTED_SESSION_SCOPE_MESSAGE/)
  assert.match(renewal, /getAccessTokenExpiresAtMs\(token\)/)
  assert.match(
    nativeBridge,
    /shouldRegisterNativePush\(isReactNativeWebView\(\), sessionMode\)/,
  )
  assert.match(nativeBridge, /Imported debug access is intentionally ephemeral/)
})
