import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useExternalAuthNavigation } from './external-auth-navigation'

/**
 * Router-rooted half of the external-auth callback bridge: supplies the in-app
 * navigator to the always-mounted provider, which lives above the router, then
 * drains any callback the native shell queued before the app was ready — at
 * this point a cold-start completion can navigate in-app.
 */
export const ExternalAuthRouterBridge = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const externalAuth = useExternalAuthNavigation()

  useEffect(() => {
    if (!externalAuth) return undefined
    const unregister = externalAuth.registerNavigate((path) => {
      void navigate(path, { replace: true })
    })
    return unregister
  }, [externalAuth, navigate])

  useEffect(() => {
    if (!externalAuth || location.pathname !== '/login') return
    externalAuth.handleWebLocation(window.location.href, window.location.origin)
  }, [externalAuth, location.pathname, location.search])

  return null
}
