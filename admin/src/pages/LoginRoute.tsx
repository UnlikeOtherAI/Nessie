import { Navigate, useLocation } from 'react-router-dom'
import {
  hasWebExternalAuthCallback,
  WEB_EXTERNAL_AUTH_COMPLETION_PATH,
} from '../lib/external-auth-callback'
import { LoginPage } from './LoginPage'

/**
 * The provider must return to /login because that exact URI is bound into its
 * authorization code. Move the callback to a dedicated screen before mounting
 * the interactive login surface, while preserving the query for the exchange.
 */
export const LoginRoute = () => {
  const location = useLocation()
  if (hasWebExternalAuthCallback(location.search)) {
    return (
      <Navigate
        replace
        to={{ pathname: WEB_EXTERNAL_AUTH_COMPLETION_PATH, search: location.search }}
      />
    )
  }
  return <LoginPage />
}
