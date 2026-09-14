import { faGithub } from '@fortawesome/free-brands-svg-icons'
import { faPause, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { readDeviceColour, writeDeviceColour } from './colour-cookie'
import { deviceColours, docsUrl, hero, heroTabs, signInUrl, type DeviceColour } from './content'
import { DeviceView } from './desktop3d'
import { Button } from './ui'

const advanceMs = 6000
const openMs = 650
const closeMs = 450

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// The transform that makes the full-screen desktop sit exactly over the hero one.
function transformFrom(origin: DOMRect, target: DOMRect) {
  const dx = origin.left + origin.width / 2 - (target.left + target.width / 2)
  const dy = origin.top + origin.height / 2 - (target.top + target.height / 2)
  return `translate(${dx}px, ${dy}px) scale(${origin.width / target.width})`
}

export function Hero() {
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [closing, setClosing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [colour, setColour] = useState<DeviceColour>(readDeviceColour)
  const trigger = useRef<HTMLButtonElement>(null)
  const closer = useRef<HTMLButtonElement>(null)
  const zoom = useRef<HTMLDivElement>(null)
  const swatches = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!playing) return undefined
    const id = window.setTimeout(() => setActive((i) => (i + 1) % heroTabs.length), advanceMs)
    return () => window.clearTimeout(id)
  }, [active, playing])

  // Opening: start the full-screen desktop over the hero one, then pan and
  // scale it into place while the backdrop fades in.
  useLayoutEffect(() => {
    const target = zoom.current
    const origin = trigger.current
    if (!expanded || !target || !origin || prefersReducedMotion()) return
    const from = transformFrom(origin.getBoundingClientRect(), target.getBoundingClientRect())
    target.animate([{ transform: from }, { transform: 'none' }], {
      duration: openMs,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    })
    swatches.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: openMs, easing: 'ease' })
  }, [expanded])

  const close = () => {
    const target = zoom.current
    const origin = trigger.current
    if (closing) return
    if (!target || !origin || prefersReducedMotion()) {
      setExpanded(false)
      return
    }
    setClosing(true)
    const to = transformFrom(origin.getBoundingClientRect(), target.getBoundingClientRect())
    const easing = 'cubic-bezier(0.4, 0, 0.2, 1)'
    const motion = target.animate([{ transform: 'none' }, { transform: to }], { duration: closeMs, easing, fill: 'forwards' })
    for (const element of [closer.current, swatches.current]) {
      element?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: closeMs, easing, fill: 'forwards' })
    }
    motion.onfinish = () => {
      setClosing(false)
      setExpanded(false)
    }
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // While zoomed: lock page scroll, close on Escape, and hand focus back to the
  // hero desktop when the view closes.
  useEffect(() => {
    if (!expanded) return undefined
    const button = trigger.current
    const previousOverflow = document.body.style.overflow
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
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

  const chooseColour = (next: DeviceColour) => {
    setColour(next)
    writeDeviceColour(next)
  }

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
        <div className={expanded ? 'n-hero-visual n-hero-visual-away' : 'n-hero-visual'} id="product">
          <button
            aria-label="See the Nessie screen up close"
            className="n-device-trigger"
            onBlur={() => setHovered(false)}
            onClick={() => {
              setExpanded(true)
              setPlaying(false)
            }}
            onFocus={() => setHovered(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            ref={trigger}
            type="button"
          >
            <DeviceView colour={colour} hovered={hovered} idPrefix="nd-hero" pose="tilted" shot={tab.shot} />
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
          <button aria-label="Close" className="n-device-backdrop" onClick={close} ref={closer} type="button">
            <FontAwesomeIcon className="n-device-close" icon={faXmark} />
          </button>
          <div aria-label="Case colour" className="n-swatches" ref={swatches} role="radiogroup">
            {deviceColours.map((option) => (
              <button
                aria-checked={option.id === colour.id}
                aria-label={option.name}
                className="n-swatch"
                key={option.id}
                onClick={() => chooseColour(option)}
                role="radio"
                style={{ background: option.front }}
                type="button"
              />
            ))}
          </div>
          <div className="n-device-zoom" ref={zoom}>
            <DeviceView
              colour={colour}
              idPrefix="nd-zoom"
              interactive
              pose={closing ? 'tilted' : 'flat'}
              shot={tab.shot}
            />
          </div>
          <p className="n-device-hint">Drag to turn it around</p>
        </div>
      )}
    </section>
  )
}
