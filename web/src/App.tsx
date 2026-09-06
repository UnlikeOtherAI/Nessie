import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { AppDownloads, SignInShowcase, SignInSurface } from '@nessie/sign-in-surface'

// The admin mints the PKCE verifier on its own origin, so this page cannot open
// the provider itself. It hands off to /login with the launch flag and the
// admin starts the UOA flow at once: one press here, the provider's screen next.
const signInUrl = 'https://app.nessie.works/login?launch=sso'

export function App() {
  return (
    <>
      <SignInSurface
        after={<AppDownloads />}
        flow
        logo={<img alt="" className="signin-wordmark-mark" src="/nessie-logo.png" />}
        productName="Nessie"
        showcase={<SignInShowcase />}
      >
        <a className="signin-cta signin-cta-primary" href={signInUrl}>
          <FontAwesomeIcon aria-hidden="true" className="signin-cta-icon" icon={faLock} />
          Sign in with SSO
        </a>
      </SignInSurface>
      <section aria-labelledby="landing-home-title" className="landing-section">
        <h2 className="landing-section-title" id="landing-home-title">
          A European home for your team.
        </h2>
        <p className="landing-section-text">
          Familiar channels, threads, and DMs.
          <br />
          People and AI agents working together.
        </p>
      </section>
    </>
  )
}
