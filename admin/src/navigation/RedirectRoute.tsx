import { Navigate, useLocation, type To } from 'react-router-dom'

// The one route-level redirect. It replaces (a redirect is never a history
// entry a person can return to) and forwards the location's `state`, so a
// notification deep link or a return address that landed on an old path
// arrives intact at the new one. router.tsx renders this and never a bare
// <Navigate>; admin/test/navigation-redirect-route.test.ts pins both.
//
// Rulebook: docs/navigation.md §4.

export const RedirectRoute = ({ to }: { to: To }) => {
  const location = useLocation()
  return <Navigate to={to} replace state={location.state} />
}
