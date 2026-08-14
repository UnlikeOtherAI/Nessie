import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nativeBackScript,
  nativeSelectTabScript,
  shouldConsumeNativeBack,
} from './native-phone-navigation'

// The native tab bar drives the admin's shared select/reselect ledger when the
// phone bridge is mounted, and degrades step by step when it is not: first the
// generic __nessieNavigate push, then a plain location change — an early tap
// can never become a silent no-op.
test('nativeSelectTabScript prefers the bridge callback, then __nessieNavigate, then location', () => {
  const calls: Array<{ args: unknown[]; fn: string }> = []
  const window: Record<string, unknown> = {
    __nessieSelectTab: (...args: unknown[]) => calls.push({ args, fn: '__nessieSelectTab' }),
    __nessieNavigate: (...args: unknown[]) => calls.push({ args, fn: '__nessieNavigate' }),
    location: { href: '' },
  }
  const run = (script: string): void => {
    void new Function('window', `with (window) { ${script} }`)(window)
  }

  run(nativeSelectTabScript('/projects'))
  assert.deepEqual(calls, [{ args: ['/projects'], fn: '__nessieSelectTab' }])

  delete window.__nessieSelectTab
  run(nativeSelectTabScript('/knowledge-base'))
  assert.deepEqual(calls[1], { args: ['/knowledge-base'], fn: '__nessieNavigate' })

  delete window.__nessieNavigate
  run(nativeSelectTabScript('/search'))
  assert.equal((window.location as { href: string }).href, '/search')
})

test('nativeSelectTabScript quotes the path safely', () => {
  const script = nativeSelectTabScript('/channels/";alert(1);//')
  assert.ok(!script.includes('alert(1);// :'))
  const window: Record<string, unknown> = {
    __nessieSelectTab: () => undefined,
    location: { href: '' },
  }
  void new Function('window', `with (window) { ${script} }`)(window)
})

test('nativeBackScript is a no-op until the bridge publishes __nessieNativeBack', () => {
  const calls: string[] = []
  const window: Record<string, unknown> = {}
  void new Function('window', `with (window) { ${nativeBackScript()} }`)(window)
  window.__nessieNativeBack = () => calls.push('back')
  void new Function('window', `with (window) { ${nativeBackScript()} }`)(window)
  assert.deepEqual(calls, ['back'])
})

// Android hardware Back: consumed only while the admin's latest report says
// the current route has an in-app parent; at tab roots the key falls through
// (handler returns false) so the platform default applies.
test('shouldConsumeNativeBack mirrors the admin back-state exactly', () => {
  assert.equal(shouldConsumeNativeBack(true), true)
  assert.equal(shouldConsumeNativeBack(false), false)
})
