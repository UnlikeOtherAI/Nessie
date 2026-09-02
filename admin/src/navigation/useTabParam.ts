import { useCallback, useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'

// One state model for every in-page tab strip (docs/navigation.md §1, "Tab
// hosts"). A tab is never a history entry, but it is part of what the screen
// currently shows, so it lives in a URL search param written with `replace`:
// `?tab=files` is linkable and survives a refresh, and browser Back leaves the
// host instead of walking its sections. No page keeps a tab in `useState`.
//
// An unknown or absent value reads as `fallback`, so a hand-typed param, a
// stale link and a strip whose items depend on data (an owner-only "Edit" tab,
// a scrum-only "Backlog") all degrade to the tab the host opens on rather than
// rendering nothing. Selecting the fallback deletes the param instead of
// spelling out the default, which keeps the common URL clean and makes the
// param mean "not the default".
//
// `fallback` is also the seam for a remembered preference: a host that stores
// its last choice (the knowledge view-mode cookie, the apps filter, the agents
// scope ledger) passes the stored value as the fallback and writes its store
// alongside `select`, so the URL wins when it carries a tab and the preference
// decides when it does not.

export const useTabParam = <T extends string>(
  name: string,
  tabs: readonly T[],
  fallback: T,
): [T, (next: T) => void] => {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const raw = searchParams.get(name)
  const active = useMemo(
    () => (tabs.some((tab) => tab === raw) ? (raw as T) : fallback),
    [fallback, raw, tabs],
  )
  // The updater form reads the params the router holds right now, so two
  // strips on one page (a view mode and a filter) cannot overwrite each
  // other's value with a stale copy, and every other param is carried over.
  // The entry's `state` is carried too: a tab change alters what the screen
  // shows, not which entry the reader is standing on.
  const state = location.state
  const select = useCallback(
    (next: T) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current)
          if (next === fallback || !tabs.some((tab) => tab === next)) params.delete(name)
          else params.set(name, next)
          return params
        },
        { replace: true, state },
      )
    },
    [fallback, name, setSearchParams, state, tabs],
  )
  return [active, select]
}
