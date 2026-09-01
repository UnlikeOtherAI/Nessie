import { useCallback, useEffect, useState } from 'react'

export type Screenshot = {
  src: string
  alt: string
  caption: string
}

type LightboxProps = {
  shots: Screenshot[]
  index: number
  onClose: () => void
  onStep: (delta: number) => void
}

function Lightbox({ shots, index, onClose, onStep }: LightboxProps) {
  const shot = shots[index]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight') onStep(1)
      if (event.key === 'ArrowLeft') onStep(-1)
    }
    document.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [onClose, onStep])

  if (!shot) return null

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={shot.caption}
      onClick={onClose}
    >
      <button className="lightbox-close" type="button" onClick={onClose} aria-label="Close">
        ×
      </button>
      {shots.length > 1 && (
        <button
          className="lightbox-step lightbox-prev"
          type="button"
          aria-label="Previous screenshot"
          onClick={(event) => {
            event.stopPropagation()
            onStep(-1)
          }}
        >
          ‹
        </button>
      )}
      <figure className="lightbox-figure" onClick={(event) => event.stopPropagation()}>
        <img className="lightbox-image" src={shot.src} alt={shot.alt} />
        <figcaption className="lightbox-caption">
          {shot.caption}
          {shots.length > 1 && (
            <span className="lightbox-counter">
              {index + 1} / {shots.length}
            </span>
          )}
        </figcaption>
      </figure>
      {shots.length > 1 && (
        <button
          className="lightbox-step lightbox-next"
          type="button"
          aria-label="Next screenshot"
          onClick={(event) => {
            event.stopPropagation()
            onStep(1)
          }}
        >
          ›
        </button>
      )}
    </div>
  )
}

export function ScreenshotGallery({ shots }: { shots: Screenshot[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const close = useCallback(() => setOpenIndex(null), [])
  const step = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null) return current
        return (current + delta + shots.length) % shots.length
      })
    },
    [shots.length],
  )

  return (
    <>
      <ul className="shot-grid">
        {shots.map((shot, index) => (
          <li key={shot.src} className="shot-item">
            <button
              className="shot-button"
              type="button"
              onClick={() => setOpenIndex(index)}
              aria-label={`Open screenshot: ${shot.caption}`}
            >
              <img
                className="shot-image"
                src={shot.src}
                alt={shot.alt}
                width={2880}
                height={1800}
                loading="lazy"
              />
              <span className="shot-caption">{shot.caption}</span>
            </button>
          </li>
        ))}
      </ul>
      {openIndex !== null && (
        <Lightbox shots={shots} index={openIndex} onClose={close} onStep={step} />
      )}
    </>
  )
}
