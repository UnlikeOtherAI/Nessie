import { faGithub } from '@fortawesome/free-brands-svg-icons'
import { faPause, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useRef, useState } from 'react'
import { docsUrl, hero, heroTabs, signInUrl } from './content'
import { DeviceView } from './desktop3d'
import { Button } from './ui'

const advanceMs = 6000

export function Hero() {
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const closer = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!playing) return undefined
    const id = window.setTimeout(() => setActive((i) => (i + 1) % heroTabs.length), advanceMs)
    return () => window.clearTimeout(id)
  }, [active, playing])

  // While zoomed: lock page scroll, close on Escape, and hand focus back to the
  // tilted desktop when the view closes.
  useEffect(() => {
    if (!expanded) return undefined
    const button = trigger.current
    const previousOverflow = document.body.style.overflow
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    closer.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
      button?.focus()
    }
  }, [expanded])

  const tab = heroTabs[active]
  if (!tab) return null

  return (
    <section className="n-hero" id="top">
      <div className="n-hero-inner">
        <div className="n-hero-copy">
          <h1 className="n-h1">{hero.title}</h1>
          <p className="n-hero-text">{hero.text}</p>
          <div className="n-actions">
            <Button href={signInUrl}>Get started</Button>
            <Button ghost href={docsUrl} icon={faGithub}>Open source</Button>
          </div>
        </div>
        <div className="n-hero-visual" id="product">
          <button
            aria-label="See the Nessie screen up close"
            className="n-device-trigger"
            onClick={() => {
              setExpanded(true)
              setPlaying(false)
            }}
            onBlur={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            ref={trigger}
            type="button"
          >
            <DeviceView hovered={hovered} idPrefix="nd-hero" pose="tilted" shot={tab.shot} />
          </button>
          <button
            aria-label={playing ? 'Pause' : 'Play'}
            className="n-stage-toggle"
            onClick={() => setPlaying(!playing)}
            type="button"
          >
            <FontAwesomeIcon icon={playing ? faPause : faPlay} />
          </button>
        </div>
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
      {expanded && (
        <div aria-label="Nessie screen, full size" aria-modal="true" className="n-device-overlay" role="dialog">
          <button
            aria-label="Close"
            className="n-device-backdrop"
            onClick={() => setExpanded(false)}
            ref={closer}
            type="button"
          >
            <FontAwesomeIcon className="n-device-close" icon={faXmark} />
          </button>
          <div className="n-device-zoom">
            <DeviceView idPrefix="nd-zoom" interactive pose="flat" shot={tab.shot} />
          </div>
          <p className="n-device-hint">Drag to turn it around</p>
        </div>
      )}
    </section>
  )
}
