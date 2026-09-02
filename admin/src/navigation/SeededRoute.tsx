import { useContext, useMemo, type ReactNode } from 'react'
import { UNSAFE_DataRouterContext, useRoutes, type RouteObject } from 'react-router-dom'

// A screen the navigation stack seeds beneath a cold start's landing route
// (docs/navigation.md §8). The page is rendered from the same route table
// the router uses — the children of the shell route — for the seeded
// pathname, so a deep link into an agent shows the Agents list beneath it
// exactly as a real navigation would have. It renders inert under the
// landed screen until the person goes Back, when the route's own commit
// replaces it.

export const useShellRoutes = (shellElementType: unknown): RouteObject[] => {
  const router = useContext(UNSAFE_DataRouterContext)?.router
  return useMemo(() => {
    const find = (routes: RouteObject[]): RouteObject[] | null => {
      for (const route of routes) {
        const element = route.element as { type?: unknown } | null | undefined
        if (element && typeof element === 'object' && element.type === shellElementType) {
          return route.children ?? []
        }
        const nested = route.children ? find(route.children) : null
        if (nested) return nested
      }
      return null
    }
    return find(router?.routes ?? []) ?? []
  }, [router, shellElementType])
}

export const SeededRoute = ({
  pathname,
  routes,
}: {
  pathname: string
  routes: RouteObject[]
}): ReactNode => useRoutes(routes, { pathname })
