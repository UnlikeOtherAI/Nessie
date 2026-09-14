import { faPause, faPlay } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState } from 'react'
import { contactUrl, hero, heroTabs, signInUrl } from './content'
import { Button } from './ui'

const advanceMs = 6000

export function Hero() {
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return undefined
    const id = window.setTimeout(() => setActive((i) => (i + 1) % heroTabs.length), advanceMs)
    return () => window.clearTimeout(id)
  }, [active, playing])

  const tab = heroTabs[active]
  if (!tab) return null

  return (
    <section className="n-hero" id="top">
      <h1 className="n-h1">{hero.title}</h1>
      <p className="n-hero-text">{hero.text}</p>
      <div className="n-actions">
        <Button href={signInUrl}>Get started</Button>
        <Button ghost href={contactUrl}>Book a demo</Button>
      </div>
      <div className="n-trusted">
        <span>{hero.trustedLabel}</span>
        <ul className="n-logo-row">
          {Array.from({ length: hero.logoSlots }, (_, i) => (
            <li className="n-logo-slot n-placeholder" key={i}>
              Logo
            </li>
          ))}
        </ul>
      </div>
      <div className="n-stage" id="product">
        <img alt={tab.shot.alt} className="n-stage-img" key={active} src={tab.shot.src} />
        <button
          aria-label={playing ? 'Pause' : 'Play'}
          className="n-stage-toggle"
          onClick={() => setPlaying(!playing)}
          type="button"
        >
          <FontAwesomeIcon icon={playing ? faPause : faPlay} />
        </button>
      </div>
      <div className="n-stage-tabs" role="tablist">
        {heroTabs.map((t, i) => (
          <button
            aria-selected={i === active}
            className="n-stage-tab"
            key={t.label}
            onClick={() => {
              setActive(i)
              setPlaying(false)
            }}
            role="tab"
            type="button"
          >
            {t.label}
            {i === active && playing && <span className="n-stage-progress" key={active} />}
          </button>
        ))}
      </div>
    </section>
  )
}
