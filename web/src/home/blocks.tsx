import { faArrowLeft, faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useRef, useState } from 'react'
import { aiBand, docsUrl, pillars, quotePlaceholder, whatsNew, type Pillar } from './content'

export function AiBand() {
  return (
    <section className="n-ai">
      <div className="n-container">
        <h2 className="n-h2">{aiBand.title}</h2>
        <p className="n-lede">{aiBand.text}</p>
        <div className="n-ai-grid">
          {aiBand.cards.map((card) => (
            <article className="n-ai-card" key={card.title}>
              <div className="n-art">
                <FontAwesomeIcon icon={card.icon} />
              </div>
              {card.tag && <span className="n-tag">{card.tag}</span>}
              <h3>{card.title}</h3>
              <p>{card.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export function WhatsNew() {
  const track = useRef<HTMLDivElement>(null)
  const scroll = (direction: number) => track.current?.scrollBy({ left: direction * 376, behavior: 'smooth' })
  return (
    <section className="n-section">
      <div className="n-container">
        <div className="n-row-head">
          <h2 className="n-h2">{whatsNew.title}</h2>
          <div className="n-row-head-actions">
            <a className="n-text-link" href={docsUrl}>
              {whatsNew.link} <FontAwesomeIcon icon={faArrowRight} />
            </a>
            <button aria-label="Previous" className="n-round-btn" onClick={() => scroll(-1)} type="button">
              <FontAwesomeIcon icon={faArrowLeft} />
            </button>
            <button aria-label="Next" className="n-round-btn" onClick={() => scroll(1)} type="button">
              <FontAwesomeIcon icon={faArrowRight} />
            </button>
          </div>
        </div>
        <div className="n-track" ref={track}>
          {whatsNew.items.map((item) => (
            <article className="n-promo" key={item.title}>
              <div className="n-art">
                <FontAwesomeIcon icon={item.icon} />
              </div>
              <span className="n-kicker">{item.tag}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function PillarBlock({ pillar }: { pillar: Pillar }) {
  return (
    <div className="n-pillar" id={pillar.id}>
      <p className="n-kicker">{pillar.label}</p>
      <h2 className="n-h2">{pillar.title}</h2>
      <p className="n-lede">{pillar.text}</p>
      {pillar.rows.map((row, i) => (
        <div className={i % 2 ? 'n-feature n-feature-flip' : 'n-feature'} key={row.title}>
          <div className="n-feature-copy">
            <h3>{row.title}</h3>
            <p>{row.text}</p>
            {row.cta && (
              <a className="n-text-link" href={docsUrl}>
                {row.cta} <FontAwesomeIcon icon={faArrowRight} />
              </a>
            )}
          </div>
          <img alt={row.shot.alt} className="n-feature-img" loading="lazy" src={row.shot.src} />
        </div>
      ))}
      {pillar.stat && (
        <div className="n-stat n-placeholder">
          <strong>{pillar.stat.value}</strong>
          <span>{pillar.stat.text}</span>
        </div>
      )}
      {pillar.quote && (
        <blockquote className="n-quote n-placeholder">
          <p>“{quotePlaceholder.text}”</p>
          <cite>{quotePlaceholder.who}</cite>
        </blockquote>
      )}
    </div>
  )
}

export function Pillars() {
  const [active, setActive] = useState(pillars[0]?.id ?? '')

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id)
      },
      { rootMargin: '-35% 0px -60% 0px' },
    )
    for (const pillar of pillars) {
      const el = document.getElementById(pillar.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <section className="n-pillars" id="pillars">
      <div className="n-container n-pillars-inner">
        <nav aria-label="Sections" className="n-pillar-nav">
          {pillars.map((pillar) => (
            <a
              aria-current={active === pillar.id ? 'true' : undefined}
              className="n-pillar-link"
              href={`#${pillar.id}`}
              key={pillar.id}
            >
              {pillar.label}
            </a>
          ))}
        </nav>
        <div className="n-pillar-body">
          {pillars.map((pillar) => (
            <PillarBlock key={pillar.id} pillar={pillar} />
          ))}
        </div>
      </div>
    </section>
  )
}
