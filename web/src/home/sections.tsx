import { faArrowRight, faBars, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState } from 'react'
import {
  agentCards,
  docsUrl,
  facts,
  footerColumns,
  hero,
  heroTabs,
  navLinks,
  quotes,
  resources,
  signInUrl,
  updates,
  type Card,
  type Pillar,
} from './content'

type CtaProps = { secondary?: boolean; href?: string; children: string }

function Cta({ secondary = false, href = signInUrl, children }: CtaProps) {
  return (
    <a className={secondary ? 'home-btn home-btn-ghost' : 'home-btn'} href={href}>
      {children}
    </a>
  )
}

export function Header() {
  const [open, setOpen] = useState(false)
  return (
    <header className="home-header">
      <div className="home-header-inner">
        <a className="home-brand" href="#top">
          <img alt="" src="/nessie-logo.png" />
          Nessie
        </a>
        <nav className={open ? 'home-nav home-nav-open' : 'home-nav'} aria-label="Main">
          {navLinks.map((link) => (
            <a href={link.href} key={link.label} onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="home-header-actions">
          <a className="home-link" href={signInUrl}>Sign in</a>
          <Cta>Get started</Cta>
          <button aria-label="Menu" className="home-menu" onClick={() => setOpen(!open)} type="button">
            <FontAwesomeIcon icon={open ? faXmark : faBars} />
          </button>
        </div>
      </div>
    </header>
  )
}

export function Hero() {
  const [active, setActive] = useState(0)
  const tab = heroTabs[active]
  if (!tab) return null
  return (
    <section className="home-hero" id="top">
      <p className="home-eyebrow">{hero.eyebrow}</p>
      <h1>{hero.title}</h1>
      <p className="home-lede">{hero.text}</p>
      <div className="home-actions">
        <Cta>Get started</Cta>
        <Cta href={docsUrl} secondary>Host it yourself</Cta>
      </div>
      <div className="home-tabs" role="tablist">
        {heroTabs.map((t, i) => (
          <button
            aria-selected={i === active}
            className="home-tab"
            key={t.label}
            onClick={() => setActive(i)}
            role="tab"
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>
      <figure className="home-shot">
        <img alt={tab.alt} src={tab.src} />
        <figcaption>{tab.caption}</figcaption>
      </figure>
    </section>
  )
}

function CardGrid({ cards }: { cards: Card[] }) {
  return (
    <div className="home-card-grid">
      {cards.map((card) => (
        <article className="home-card" key={card.title}>
          <FontAwesomeIcon className="home-card-icon" icon={card.icon} />
          <h3>{card.title}</h3>
          <p>{card.text}</p>
        </article>
      ))}
    </div>
  )
}

export function AgentsIntro() {
  return (
    <section className="home-section">
      <h2 className="home-h2">Agents that do the work, not just talk about it.</h2>
      <p className="home-sub">
        Nessie’s agents act inside the conversation — with the context of your team and a person’s
        approval where it matters.
      </p>
      <CardGrid cards={agentCards} />
    </section>
  )
}

export function Updates() {
  return (
    <section className="home-section home-updates">
      <div className="home-row-head">
        <h2 className="home-h3">Recently shipped</h2>
        <a className="home-link" href={docsUrl}>
          All updates <FontAwesomeIcon icon={faArrowRight} />
        </a>
      </div>
      <div className="home-scroller">
        {updates.map((u) => (
          <article className="home-update" key={u.title}>
            <span className="home-tag">{u.tag}</span>
            <h3>{u.title}</h3>
            <p>{u.text}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function PillarSection({ pillar }: { pillar: Pillar }) {
  return (
    <section className="home-section home-pillar" id={pillar.id}>
      <p className="home-eyebrow">{pillar.label}</p>
      <h2 className="home-h2">{pillar.title}</h2>
      <p className="home-sub">{pillar.text}</p>
      <div className={pillar.reverse ? 'home-split home-split-reverse' : 'home-split'}>
        <ul className="home-features">
          {pillar.features.map((f) => (
            <li key={f.title}>
              <FontAwesomeIcon className="home-card-icon" icon={f.icon} />
              <div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
        <img alt={pillar.image.alt} className="home-split-img" loading="lazy" src={pillar.image.src} />
      </div>
      <div className={pillar.stat.placeholder ? 'home-stat home-placeholder' : 'home-stat'}>
        <strong>{pillar.stat.value}</strong>
        <span>{pillar.stat.text}</span>
      </div>
    </section>
  )
}

export function Quote({ index }: { index: number }) {
  const q = quotes[index]
  if (!q) return null
  return (
    <blockquote className="home-quote home-placeholder">
      <p>“{q.text}”</p>
      <cite>{q.who}</cite>
    </blockquote>
  )
}

export function Facts() {
  return (
    <section className="home-band">
      <h2 className="home-h2">Built for teams who want both speed and control.</h2>
      <div className="home-facts">
        {facts.map((f) => (
          <div className="home-fact" key={f.text}>
            <strong>{f.value}</strong>
            <span>{f.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function Resources() {
  return (
    <section className="home-section" id="resources">
      <h2 className="home-h2">Go deeper.</h2>
      <div className="home-resources">
        {resources.map((r) => (
          <a className="home-resource" href={r.href} key={r.title}>
            <FontAwesomeIcon className="home-card-icon" icon={r.icon} />
            <span className="home-tag">{r.kind}</span>
            <h3>{r.title}</h3>
            <span className="home-link">
              {r.cta} <FontAwesomeIcon icon={faArrowRight} />
            </span>
          </a>
        ))}
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="home-final">
      <h2 className="home-h2">Bring your team — and its agents — home.</h2>
      <div className="home-actions">
        <Cta>Get started</Cta>
        <Cta href="mailto:hello@nessie.works" secondary>Talk to us</Cta>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="home-footer">
      <div className="home-footer-inner">
        <div>
          <a className="home-brand" href="#top">
            <img alt="" src="/nessie-logo.png" />
            Nessie
          </a>
          <p>The European Slack alternative for an AI world.</p>
        </div>
        {footerColumns.map((col) => (
          <div key={col.title}>
            <h4>{col.title}</h4>
            <ul>
              {col.links.map((l) => (
                <li key={l}>
                  <a href="#top">{l}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="home-legal">© {new Date().getFullYear()} UnlikeOtherAI · Licensed under FSL-1.1-ALv2</p>
    </footer>
  )
}
