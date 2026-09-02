import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useRedirect } from './redirect'

// The one consume path for intent params (docs/navigation/overview.md §8). A link can
// carry an instruction as well as an address — open this page, highlight
// that message, accept this call, review this change — and the registry row
// declares each such name under `intent.consume` (a search param) or
// `intent.hash` (a fragment). A screen reads them only through these hooks,
// which capture the value into component state and then strip it from the
// URL with one deferred, replacing redirect: Back and a refresh land on the
// address, never on the instruction, and the strip waits for a running
// slide rather than starting a second one.
//
// `serial` increments on every arrival, so an effect keyed on it acts once
// per link even when the same value arrives twice (two pushes for one
// message). Linkable params that describe what a screen shows — a tab, a
// filter, a query — are `intent.state` and stay in the URL; they read through
// `useTabParam` or `useSearchParams`, never through here.
//
// Pass a module-level constant as `names`: it is a hook dependency.

export type IntentValues<N extends string> = Readonly<Record<N, string | null>>

export type IntentCapture<N extends string> = {
  serial: number
  values: IntentValues<N>
}

export type IntentValue = {
  serial: number
  value: string | null
}

export type ConsumeIntentOptions = {
  // A consumer mounted above the screen that owns the intent (a provider)
  // consumes only while the screen is the one it belongs to.
  enabled?: boolean
}

export const readIntentValues = <N extends string>(
  search: string,
  names: readonly N[],
): IntentValues<N> => {
  const params = new URLSearchParams(search)
  const values = {} as Record<N, string | null>
  for (const name of names) values[name] = params.get(name)
  return values
}

// The search string with the named params removed: '' when nothing is left,
// so the redirect target carries no dangling '?'.
export const stripIntentParams = (search: string, names: readonly string[]): string => {
  const params = new URLSearchParams(search)
  for (const name of names) params.delete(name)
  const next = params.toString()
  return next ? `?${next}` : ''
}

const emptyValues = <N extends string>(names: readonly N[]): IntentValues<N> => {
  const values = {} as Record<N, string | null>
  for (const name of names) values[name] = null
  return values
}

const hasValue = (values: IntentValues<string>): boolean =>
  Object.values(values).some((value) => value !== null)

type Redirect = ReturnType<typeof useRedirect>

// One strip per location. Two hooks on one screen (a channel's `?messageId=`
// and its `?acceptCall=`, a page's search intent and its fragment) each
// register what they consumed, and one replacing redirect at the end of the
// commit removes all of it. Two independent redirects would race: the second
// is dropped because the first moved the location, its param survives at a
// new key, and the hook that lost captures the same link twice.
const pendingStrip = {
  hash: false,
  key: null as string | null,
  names: new Set<string>(),
  scheduled: false,
}

const scheduleStrip = (
  redirect: Redirect,
  location: { hash: string; key: string; pathname: string; search: string; state: unknown },
  names: readonly string[],
  hash: boolean,
): void => {
  if (pendingStrip.key !== location.key) {
    pendingStrip.key = location.key
    pendingStrip.names.clear()
    pendingStrip.hash = false
  }
  for (const name of names) pendingStrip.names.add(name)
  if (hash) pendingStrip.hash = true
  if (pendingStrip.scheduled) return
  pendingStrip.scheduled = true
  queueMicrotask(() => {
    pendingStrip.scheduled = false
    redirect(
      {
        hash: pendingStrip.hash ? '' : location.hash,
        pathname: location.pathname,
        search: stripIntentParams(location.search, [...pendingStrip.names]),
      },
      { state: location.state },
    )
  })
}

export const useConsumedIntents = <N extends string>(
  names: readonly N[],
  options?: ConsumeIntentOptions,
): IntentCapture<N> => {
  const location = useLocation()
  const redirect = useRedirect()
  const enabled = options?.enabled ?? true
  const [capture, setCapture] = useState<IntentCapture<N>>(() => ({
    serial: 0,
    values: emptyValues(names),
  }))
  // One arrival is one (entry, search) pair: a re-render and the strip's
  // own deferred wait see the same stamp and do not capture twice.
  const consumedStamp = useRef<string | null>(null)
  const { hash, key, pathname, search, state } = location

  useEffect(() => {
    if (!enabled) return
    const values = readIntentValues(search, names)
    if (!hasValue(values)) return
    const stamp = `${key}${search}`
    if (consumedStamp.current === stamp) return
    consumedStamp.current = stamp
    setCapture((previous) => ({ serial: previous.serial + 1, values }))
    scheduleStrip(redirect, { hash, key, pathname, search, state }, names, false)
  }, [enabled, hash, key, names, pathname, redirect, search, state])

  return capture
}

export const useConsumedIntent = (name: string, options?: ConsumeIntentOptions): IntentValue => {
  // A one-name tuple kept stable per name, so the effect above keys on the
  // name rather than a fresh array each render.
  const namesRef = useRef<readonly string[]>([name])
  if (namesRef.current[0] !== name) namesRef.current = [name]
  const capture = useConsumedIntents(namesRef.current, options)
  return { serial: capture.serial, value: capture.values[name] ?? null }
}

// A fragment intent: `#trigger-<id>`, `#confirmationToken=<token>`. `parse`
// turns the whole hash into the value or null and must be a module-level
// constant (it is a hook dependency); the hook strips the fragment through
// the same one redirect as the params above.
export const useConsumedHashIntent = (
  name: string,
  parse: (hash: string) => string | null,
): IntentValue => {
  const location = useLocation()
  const redirect = useRedirect()
  const [capture, setCapture] = useState<IntentValue>({ serial: 0, value: null })
  const consumedStamp = useRef<string | null>(null)
  const { hash, key, pathname, search, state } = location

  useEffect(() => {
    const value = parse(hash)
    if (value === null) return
    const stamp = `${key}${hash}`
    if (consumedStamp.current === stamp) return
    consumedStamp.current = stamp
    setCapture((previous) => ({ serial: previous.serial + 1, value }))
    scheduleStrip(redirect, { hash, key, pathname, search, state }, [], true)
    // `name` is the registry's declared key, read by the gate and the
    // consumer, not by the parse.
  }, [hash, key, name, parse, pathname, redirect, search, state])

  return capture
}

// The two fragment shapes in use. Anchor style for a row to select
// (`#trigger-<id>`), param style for a value handed over (`#name=<value>`).
export const parseHashAnchor = (name: string) => (hash: string): string | null => {
  const prefix = `#${name}-`
  if (!hash.startsWith(prefix)) return null
  const encoded = hash.slice(prefix.length)
  return encoded ? decodeURIComponent(encoded) : null
}

export const parseHashParam = (name: string) => (hash: string): string | null =>
  new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(name)
