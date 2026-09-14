import { faGithub } from '@fortawesome/free-brands-svg-icons'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { readDeviceColour, writeDeviceColour } from './colour-cookie'
import { deviceColours, docsUrl, hero, heroTabs, signInUrl, type DeviceColour } from './content'
import { DeviceView } from './desktop3d'
import { Button } from './ui'

// Screenshots rotate slowly; the dots under the desktop jump between them.
const advanceMs = 9000
const openMs = 650
const closeMs = 480
const easeOut = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const easeInOut = 'cubic-bezier(0.4, 0, 0.2, 1)'

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// The transform that draws a box at `target` over the box at `origin`.
function transformFrom(origin: DOMRect, target: DOMRect) {
  const dx = origin.left + origin.width / 2 - (target.left + target.width / 2)
  const dy = origin.top + origin.height / 2 - (target.top + target.height / 2)
  return `translate(${dx}px, ${dy}px) scale(${origin.width / target.width})`
}

export function Hero() {
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState(false)
  // Screenshots advance on their own, except while the desktop is full screen.
  const playing = !expanded
  const [closing, setClosing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [colour, setColour] = useState<DeviceColour>(readDeviceColour)
  const slot = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLButtonElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const closer = useRef<HTMLButtonElement>(null)
  const openFrom = useRef<DOMRect | null>(null)
  const closeMotion = useRef<Animation | null>(null)

  useEffect(() => {
    if (!playing) return undefined
    const id = window.setTimeout(() => setActive((i) => (i + 1) % heroTabs.length), advanceMs)
    return () => window.clearTimeout(id)
  }, [active, playing])

  const open = () => {
    if (expanded) return
    openFrom.current = stage.current?.getBoundingClientRect() ?? null
    setHovered(false)
    setExpanded(true)
  }

  const onStageKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  }

  // One 3D scene serves both views. Opening moves the stage out of the hero
  // into a fixed, centred box, draws it back over the hero spot, then eases it
  // into place — the same canvas flies, so nothing reloads or swaps mid-way.
  useLayoutEffect(() => {
    const element = stage.current
    if (!expanded) {
      closeMotion.current?.cancel()
      closeMotion.current = null
      return
    }
    const from = openFrom.current
    if (!element || !from || prefersReducedMotion()) return
    const start = transformFrom(from, element.getBoundingClientRect())
    element.animate([{ transform: start }, { transform: 'none' }], { duration: openMs, easing: easeOut })
    for (const layer of [backdrop.current, controls.current]) {
      layer?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: openMs, easing: 'ease' })
    }
  }, [expanded])

  const close = () => {
    const element = stage.current
    const home = slot.current
    if (!expanded || closing) return
    if (!element || !home || prefersReducedMotion()) {
      setExpanded(false)
      return
    }
    setClosing(true)
    const end = transformFrom(home.getBoundingClientRect(), element.getBoundingClientRect())
    const motion = element.animate([{ transform: 'none' }, { transform: end }], {
      duration: closeMs,
      easing: easeInOut,
      fill: 'forwards',
    })
    for (const layer of [backdrop.current, controls.current]) {
      layer?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: closeMs, easing: easeInOut, fill: 'forwards' })
    }
    closeMotion.current = motion
    motion.onfinish = () => {
      setClosing(false)
      setExpanded(false)
    }
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // While full screen: lock page scroll, close on Escape, and hand focus back
  // to the hero desktop when the view closes.
  useEffect(() => {
    if (!expanded) return undefined
    const home = stage.current
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
      home?.focus()
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
          <div className="n-device-slot" ref={slot}>
            <div
              aria-label={expanded ? undefined : 'See the Nessie screen up close'}
              className={expanded ? 'n-device-stage n-device-stage-full' : 'n-device-stage'}
              onBlur={() => setHovered(false)}
              onClick={expanded ? undefined : open}
              onFocus={() => setHovered(!expanded)}
              onKeyDown={expanded ? undefined : onStageKey}
              onMouseEnter={() => setHovered(!expanded)}
              onMouseLeave={() => setHovered(false)}
              ref={stage}
              role={expanded ? undefined : 'button'}
              tabIndex={expanded ? -1 : 0}
            >
              <DeviceView
                colour={colour}
                hovered={hovered}
                idPrefix="nd-hero"
                interactive={expanded && !closing}
                pose={expanded && !closing ? 'flat' : 'tilted'}
                shot={tab.shot}
              />
            </div>
          </div>
          <div aria-label="Screenshots" className="n-shot-dots" role="tablist">
            {heroTabs.map((t, i) => (
              <button
                aria-label={t.label}
                aria-selected={i === active}
                className="n-shot-dot"
                key={t.label}
                onClick={() => setActive(i)}
                role="tab"
                type="button"
              />
            ))}
          </div>
        </div>
      </div>
      {expanded && (
        <>
          <button
            aria-hidden="true"
            className="n-device-backdrop"
            onClick={close}
            ref={backdrop}
            tabIndex={-1}
            type="button"
          />
          <div aria-label="Nessie screen, full size" className="n-device-controls" ref={controls} role="dialog">
            <button aria-label="Close" className="n-device-close-button" onClick={close} ref={closer} type="button">
              <FontAwesomeIcon icon={faXmark} />
            </button>
            <div aria-label="Case colour" className="n-swatches" role="radiogroup">
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
          </div>        </>
      )}
    </section>
  )
}
