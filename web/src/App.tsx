const loginUrl = 'https://app.nessie.works/login'

export function App() {
  return (
    <main className="holding-page">
      <section className="holding-panel" aria-label="Nessie private beta">
        <img className="holding-logo" src="/nessie-logo.png" alt="Nessie" />
        <p className="holding-status">Private beta</p>
        <a className="login-button" href={loginUrl}>
          Login
        </a>
      </section>
    </main>
  )
}
