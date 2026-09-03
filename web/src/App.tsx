import { ScreenshotGallery, type Screenshot } from './ScreenshotGallery'

const loginUrl = 'https://app.nessie.works/login'

const shots: Screenshot[] = [
  {
    src: '/screenshots/nessie-assistant.png',
    alt: 'A Nessie thread where the assistant drafts an all-team note about a new expense policy.',
    caption: 'Ask in a thread. Get the draft back in one.',
  },
  {
    src: '/screenshots/nessie-actions.png',
    alt: 'The assistant confirming it posted the note to #General and scheduled a follow-up check.',
    caption: 'It posts, schedules and follows up — not just answers.',
  },
  {
    src: '/screenshots/nessie-channel.png',
    alt: 'The #General channel in Nessie showing the published expense policy note.',
    caption: 'Channels, threads and DMs your team already knows.',
  },
]

export function App() {
  return (
    <main className="page">
      <header className="hero">
        <img className="hero-logo" src="/nessie-logo.png" alt="Nessie" />
        <p className="hero-eyebrow">Coming soon</p>
        <h1 className="hero-title">The Slack alternative for an AI world</h1>
        <p className="hero-lede">
          Your team and its agents in one team. Same channels, threads and DMs you already
          know — except the assistants in them can draft the note, post it to the right channel and
          set the follow-up themselves.
        </p>
        <a className="login-button" href={loginUrl}>
          Login
        </a>
        <p className="hero-note">Private beta</p>
      </header>

      <section className="shots" aria-label="Screenshots of Nessie">
        <ScreenshotGallery shots={shots} />
      </section>

      <footer className="page-footer">
        <p>© {new Date().getFullYear()} Nessie</p>
      </footer>
    </main>
  )
}
