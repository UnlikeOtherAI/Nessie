// The consent bar must not ask twice.
//
// It used to store the answer only in `localStorage`, which is per-origin,
// while `nessie.works` and `www.nessie.works` both serve this site — so
// choosing on one and arriving at the other brought the bar back, on a page
// whose whole subject is respecting that choice. These hold the cookie's shape
// and scope, because that scope is the fix.
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { CONSENT_KEY, readConsent, writeConsent } from '../src/home/cookie-consent'

/** A document.cookie that behaves like a browser's for one host. */
const installDocument = (): { jar: string[] } => {
  const jar: string[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        return jar
          .map((entry) => entry.split(';')[0])
          .join('; ')
      },
      set cookie(next: string) { jar.push(next) },
    },
  })
  return { jar }
}

const installLocation = (href: string): void => {
  const url = new URL(href)
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: new Map<string, string>(Object.entries({})) as never,
      location: { hostname: url.hostname, protocol: url.protocol },
    },
  })
  const store = new Map<string, string>()
  ;(globalThis as { window: { localStorage: unknown } }).window.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

beforeEach(() => { installLocation('https://nessie.works/') })

test('the choice is written as a cookie on the registrable domain, so www and apex agree', () => {
  const { jar } = installDocument()
  writeConsent({ analytics: true })
  const written = jar.at(-1) ?? ''
  assert.ok(written.startsWith(`${CONSENT_KEY}=`))
  assert.ok(written.includes('Domain=.nessie.works'), `apex and www must share it: ${written}`)
  assert.ok(written.includes('Path=/'))
  assert.ok(written.includes('SameSite=Lax'))
  assert.ok(written.includes('Secure'), 'an https page must not write an insecure cookie')
  assert.ok(/Max-Age=\d{6,}/u.test(written), 'a consent that expires next week is a bar that returns')
})

test('www writes the same domain as the apex, which is the bug this fixes', () => {
  installLocation('https://www.nessie.works/')
  const { jar } = installDocument()
  writeConsent({ analytics: false })
  assert.ok((jar.at(-1) ?? '').includes('Domain=.nessie.works'))
})

test('localhost gets no Domain and no Secure, or the browser drops it', () => {
  installLocation('http://localhost:5472/')
  const { jar } = installDocument()
  writeConsent({ analytics: false })
  const written = jar.at(-1) ?? ''
  assert.ok(!written.includes('Domain='))
  assert.ok(!written.includes('Secure'))
})

test('an IP literal gets no Domain, which browsers would reject outright', () => {
  installLocation('http://127.0.0.1:5472/')
  const { jar } = installDocument()
  writeConsent({ analytics: false })
  assert.ok(!(jar.at(-1) ?? '').includes('Domain='))
})

test('a written choice reads back, and an unanswered bar reads as null', () => {
  installDocument()
  assert.equal(readConsent(), null)
  writeConsent({ analytics: true })
  assert.deepEqual(readConsent(), { analytics: true })
})

test('a choice left in localStorage by an earlier visit still counts', () => {
  installDocument()
  window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ analytics: true }))
  assert.deepEqual(readConsent(), { analytics: true }, 'upgrading must not ask anybody twice')
})

test('a corrupt value reads as no answer rather than throwing', () => {
  installDocument()
  window.localStorage.setItem(CONSENT_KEY, '{not json')
  assert.equal(readConsent(), null)
})
