const pillars = [
  {
    body: 'Run the workspace on your machine, keep data close, and bring hosted deployment later on the same core.',
    title: 'Local-first',
  },
  {
    body: 'Channels, agents, and streaming replies stay visible instead of disappearing behind a black box.',
    title: 'Built for live work',
  },
  {
    body: 'Use safe tools, inspect the trail, and watch sub-agents split work without losing the thread.',
    title: 'Auditable by default',
  },
  {
    body: 'Start with one agent, then spin out focused helpers that inherit the right context and stay observable.',
    title: 'Multi-agent on demand',
  },
] as const

const steps = [
  'Start a local workspace',
  'Open a channel and add an agent',
  'Stream replies and tool activity live',
] as const

export function App() {
  return (
    <main className="landing-shell">
      <div className="landing-grid" />
      <section className="hero">
        <p className="eyebrow">Nessie</p>
        <h1>Your AI coworker, running right next to you, not in the cloud.</h1>
        <p className="hero-copy">
          Nessie gives you a local-first agent workspace with real channels, real streaming,
          and safe tools that stay inspectable from the first run.
        </p>

        <div className="hero-actions">
          <a className="button button-primary" href="/admin">
            Open admin
          </a>
          <a className="button button-secondary" href="https://github.com/UnlikeOtherAI/Nessie">
            View repository
          </a>
        </div>

        <ol className="steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="pillars" aria-label="Product pillars">
        {pillars.map((pillar) => (
          <article key={pillar.title} className="pillar-card">
            <p className="pillar-index">{pillar.title}</p>
            <h2>{pillar.title}</h2>
            <p>{pillar.body}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
