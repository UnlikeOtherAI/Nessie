import { faGithub } from '@fortawesome/free-brands-svg-icons'
import { faArrowRight, faPlay } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  docsUrl,
  finalCta,
  footerColumns,
  legalLinks,
  love,
  promos,
  signInUrl,
  statsBand,
  stories,
} from './content'
import { Button, openCookieEvent } from './ui'

export function Stories() {
  return (
    <section className="n-section">
      <div className="n-container">
        <h2 className="n-h2 n-center">{stories.title}</h2>
        <div className="n-story-grid">
          {stories.cards.map((card) => (
            <article className="n-story n-placeholder" key={card.title}>
              <span className="n-story-play">
                <FontAwesomeIcon icon={faPlay} />
              </span>
              <h3>{card.title}</h3>
              <p>{card.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export function StatsBand() {
  return (
    <section className="n-stats">
      <div className="n-container">
        <h2 className="n-h2">{statsBand.title}</h2>
        <div className="n-stats-grid">
          {statsBand.stats.map((stat) => (
            <div className="n-big-stat" key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function Love() {
  return (
    <section className="n-section">
      <div className="n-container">
        <h2 className="n-h2 n-center">{love.title}</h2>
        <div className="n-love-grid">
          {love.facts.map((fact) => (
            <div className="n-love" key={fact.label}>
              <strong>{fact.value}</strong>
              <span>{fact.label}</span>
            </div>
          ))}
        </div>
        <p className="n-rating n-placeholder">{love.ratingPlaceholder}</p>
      </div>
    </section>
  )
}

export function Promos() {
  return (
    <section className="n-section n-section-tight" id="resources">
      <div className="n-container">
        <h2 className="n-h2">{promos.title}</h2>
        <div className="n-promo-grid">
          {promos.items.map((item) => (
            <a className="n-promo n-promo-link" href={item.href} key={item.title}>
              <div className="n-art">
                <FontAwesomeIcon icon={item.icon} />
              </div>
              <span className="n-kicker">{item.kind}</span>
              <h3>{item.title}</h3>
              <span className="n-text-link n-upper">
                {item.cta} <FontAwesomeIcon icon={faArrowRight} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="n-final" id="final">
      <h2 className="n-h2">{finalCta.title}</h2>
      <div className="n-actions">
        <Button href={signInUrl} light>Get started</Button>
        <Button ghost href={docsUrl} icon={faGithub} light>Open source</Button>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="n-footer">
      <div className="n-container">
        <div className="n-footer-grid">
          <a className="n-brand" href="#top">
            <img alt="" src="/nessie-mark.svg" />
            nessie
          </a>
          {footerColumns.map((column) => (
            <div key={column.title}>
              <h4>{column.title}</h4>
              <ul>
                {column.links.map((link) => (
                  <li key={link}>
                    <a href="#top">{link}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="n-footer-legal">
          <span>© {new Date().getFullYear()} UnlikeOtherAI. Licensed under FSL-1.1-ALv2.</span>
          <div>
            {legalLinks.map((link) => (
              <a href="#top" key={link}>
                {link}
              </a>
            ))}
            <button onClick={() => window.dispatchEvent(new Event(openCookieEvent))} type="button">
              Cookie preferences
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
