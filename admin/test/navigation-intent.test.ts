import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { SURFACES } from '../src/navigation/surfaces'
import { parseHashAnchor, parseHashParam, stripIntentParams } from '../src/navigation/intent'

// Intent params are declared, not improvised (docs/navigation.md §8): every
// one-shot instruction a link can carry is listed on its registry row under
// `intent.consume` (search) or `intent.hash` (fragment), and is read only
// through `navigation/intent.ts`, which captures it and strips it with one
// replacing redirect. The gates below hold both halves; the behaviour tests
// pin the capture, the strip, the forwarded state and the per-arrival serial.

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${entry}`
    if (statSync(path).isDirectory()) walk(`${path}/`, out)
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}
const sources = walk(srcRoot).map((path) => ({
  path: path.slice(srcRoot.length),
  text: readFileSync(path, 'utf8'),
}))

const consumedNames = new Set<string>()
const hashNames = new Set<string>()
for (const surface of SURFACES) {
  for (const name of surface.intent?.consume ?? []) consumedNames.add(name)
  for (const name of surface.intent?.hash ?? []) hashNames.add(name)
}

test('the registry declares the intents the app links with', () => {
  assert.deepEqual(
    [...consumedNames].sort(),
    ['acceptCall', 'connect', 'create', 'incomingCall', 'messageId', 'pageId', 'scopeProjectId', 'spaceId', 'uoa_billing'],
  )
  assert.deepEqual([...hashNames].sort(), ['confirmationToken', 'trigger'])
  // A name is either consumed or state on a row, never both.
  for (const surface of SURFACES) {
    const state = new Set(surface.intent?.state ?? [])
    for (const name of surface.intent?.consume ?? []) {
      assert.equal(state.has(name), false, `${surface.pattern}: ${name} is both consume and state`)
    }
  }
})

test('a consumed name is read only through the intent hooks', () => {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    if (path === 'navigation/intent.ts') continue
    for (const name of consumedNames) {
      const reader = new RegExp(`\\.(?:get|getAll|has)\\((['"])${name}\\1\\)`)
      if (reader.test(text)) offenders.push(`${path}: reads ?${name} directly`)
    }
    for (const name of hashNames) {
      // A regex or startsWith over the fragment is a second parser; a link
      // that writes `#trigger-<id>` and a comment that names it are not.
      if (new RegExp(`/\\^?#${name}-|startsWith\\((['"])#${name}-`).test(text)) {
        offenders.push(`${path}: parses #${name} directly`)
      }
      if (new RegExp(`\\.get\\((['"])${name}\\1\\)`).test(text)) {
        offenders.push(`${path}: reads #${name} directly`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('every intent a screen consumes is declared on a registry row', () => {
  const undeclared: string[] = []
  for (const { path, text } of sources) {
    if (path === 'navigation/intent.ts') continue
    for (const match of text.matchAll(/useConsumedIntent\((?:['"]([^'"]+)['"]|([A-Z_]+))/g)) {
      const name = match[1] ?? resolveConstant(text, match[2] as string)
      if (!consumedNames.has(name)) undeclared.push(`${path}: ?${name}`)
    }
    for (const match of text.matchAll(/useConsumedHashIntent\(['"]([^'"]+)['"]/g)) {
      if (!hashNames.has(match[1] as string)) undeclared.push(`${path}: #${match[1]}`)
    }
    for (const match of text.matchAll(/useConsumedIntents\(([A-Z_]+)/g)) {
      for (const name of resolveConstantList(text, match[1] as string)) {
        if (!consumedNames.has(name)) undeclared.push(`${path}: ?${name}`)
      }
    }
  }
  assert.deepEqual(undeclared, [])
})

const resolveConstant = (text: string, identifier: string): string => {
  const own = new RegExp(`const ${identifier} = ['"]([^'"]+)['"]`).exec(text)
  if (own) return own[1] as string
  // An imported constant: the billing return parameter.
  if (identifier === 'UOA_BILLING_CHECKOUT_RETURN_PARAMETER') return 'uoa_billing'
  throw new Error(`cannot resolve ${identifier}`)
}

const resolveConstantList = (text: string, identifier: string): string[] => {
  const own = new RegExp(`const ${identifier} = \\[([^\\]]+)\\] as const`).exec(text)
  assert.ok(own, `cannot resolve ${identifier}`)
  return [...(own[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
}

test('nothing writes the address behind the router or wipes every param', () => {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    // The router owns the address: a bare replaceState leaves the ledger and
    // the stack with a location they never saw.
    if (/history\.(?:replaceState|pushState)\(/.test(text)) offenders.push(`${path}: history.*State`)
    // Stripping one intent by replacing the whole param set is what wiped
    // the knowledge view-mode tab alongside the deep link it consumed.
    if (/setSearchParams\(\{\}/.test(text)) offenders.push(`${path}: setSearchParams({})`)
  }
  assert.deepEqual(offenders, [])
})

test('stripIntentParams removes only the named params and drops a bare "?"', () => {
  assert.equal(stripIntentParams('?connect=true&tab=accounts', ['connect']), '?tab=accounts')
  assert.equal(stripIntentParams('?connect=true', ['connect']), '')
  assert.equal(stripIntentParams('', ['connect']), '')
  assert.equal(parseHashAnchor('trigger')('#trigger-abc%20d'), 'abc d')
  assert.equal(parseHashAnchor('trigger')('#other-1'), null)
  assert.equal(parseHashAnchor('trigger')('#trigger-'), null)
  assert.equal(parseHashParam('confirmationToken')('#confirmationToken=tok&x=1'), 'tok')
  assert.equal(parseHashParam('confirmationToken')(''), null)
})

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const withDom = async (run: (dom: JSDOM) => Promise<void>): Promise<void> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    await run(dom)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

const CONNECT = 'connect'
const TRIGGER_PARSE = parseHashAnchor('trigger')

test('a consumed intent is captured once, stripped with replace, and its state forwarded', async () => {
  await withDom(async (dom) => {
    const React = await import('react')
    const { act, createElement: h } = React
    const { createRoot } = await import('react-dom/client')
    const { createMemoryRouter, RouterProvider, useLocation } = await import('react-router-dom')
    const { useConsumedIntent, useConsumedHashIntent } = await import('../src/navigation/intent')
    const { useTrackLocationKey } = await import('../src/navigation/redirect')

    const seen: Array<{ value: string | null; serial: number }> = []
    const hashes: Array<{ value: string | null; serial: number }> = []
    const Probe = ({ enabled }: { enabled: boolean }) => {
      useTrackLocationKey()
      const location = useLocation()
      const intent = useConsumedIntent(CONNECT, { enabled })
      const hash = useConsumedHashIntent('trigger', TRIGGER_PARSE)
      seen.push(intent)
      hashes.push(hash)
      return h('p', null, `${location.search}|${location.hash}|${JSON.stringify(location.state)}`)
    }
    const router = createMemoryRouter([
      { path: '/before', element: h('p', null, 'Before') },
      { path: '/apps/:slug', element: h(Probe, { enabled: true }) },
      { path: '/held/:slug', element: h(Probe, { enabled: false }) },
    ], {
      initialEntries: [
        '/before',
        { pathname: '/apps/x', search: '?connect=true&tab=accounts', hash: '#trigger-t1', state: { origin: '/before' } },
      ],
      initialIndex: 1,
    })
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(h(RouterProvider, { router })))
      await settle(act)

      const latest = seen[seen.length - 1]
      assert.deepEqual(latest, { serial: 1, value: 'true' })
      assert.deepEqual(hashes[hashes.length - 1], { serial: 1, value: 't1' })
      // Stripped: the instruction is gone, the linkable tab and the entry's
      // state remain, and the address was replaced rather than pushed.
      assert.equal(router.state.location.search, '?tab=accounts')
      assert.equal(router.state.location.hash, '')
      assert.deepEqual(router.state.location.state, { origin: '/before' })
      assert.equal(container.textContent, '?tab=accounts||{"origin":"/before"}')

      // The same value arriving again on the mounted screen is a new
      // arrival: the serial moves so an effect keyed on it acts twice for
      // two links.
      await act(async () => { await router.navigate('/apps/x?connect=true') })
      await settle(act)
      assert.deepEqual(seen[seen.length - 1], { serial: 2, value: 'true' })
      assert.equal(router.state.location.search, '')
      // Each strip replaced its own entry: Back walks the two arrivals, then
      // leaves.
      await act(async () => { await router.navigate(-1) })
      assert.equal(`${router.state.location.pathname}${router.state.location.search}`, '/apps/x?tab=accounts')
      await act(async () => { await router.navigate(-1) })
      assert.equal(router.state.location.pathname, '/before')

      // A disabled consumer neither captures nor strips.
      await act(async () => { await router.navigate('/held/y?connect=true') })
      await settle(act)
      assert.deepEqual(seen[seen.length - 1], { serial: 0, value: null })
      assert.equal(router.state.location.search, '?connect=true')
    } finally {
      await act(async () => root.unmount())
    }
  })
})
