import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { AppDownloads, SignInShowcase, SignInSurface } from '@nessie/sign-in-surface'

// The admin mints the PKCE verifier on its own origin, so this page cannot open
// the provider itself. It hands off to /login with the launch flag and the
// admin starts the UOA flow at once: one press here, the provider's screen next.
const signInUrl = 'https://app.nessie.works/login?launch=sso'

export function App() {
  return (
    <SignInSurface
      after={<AppDownloads />}
      logo={<img alt="" className="signin-wordmark-mark" src="/nessie-logo.png" />}
      productName="Nessie"
      showcase={<SignInShowcase />}
    >
      <a className="signin-cta signin-cta-primary" href={signInUrl}>
        <FontAwesomeIcon aria-hidden="true" className="signin-cta-icon" icon={faLock} />
        Sign in with SSO
      </a>
    </SignInSurface>
  )
}
