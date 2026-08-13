import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useModalA11y } from './useModalA11y'

// On-screen editing stage (square). The crop is inscribed in it, with either a
// circular or rounded-square mask. The exported image is rendered at a fixed
// higher resolution regardless of the stage size.
const STAGE = 320
const OUTPUT = 512
const ROUNDED_OUTPUT_RADIUS = 64
const MIN_ZOOM = 1
const MAX_ZOOM = 3

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

type Offset = { x: number; y: number }

type CircleImageCropperProps = {
  file: File
  busy?: boolean
  onCancel: () => void
  onSave: (blob: Blob) => void
  // Wording is caller-supplied so the same cropper serves logos, avatars, etc.
  title?: string
  description?: string
  saveLabel?: string
  shape?: 'circle' | 'rounded'
}

// Reusable modal editor: a square stage with a semi-transparent mask and a centred
// crop shape. The user pans (drag) and zooms (slider / wheel) the image to frame
// the saved image.
export const CircleImageCropper = ({
  file,
  busy = false,
  onCancel,
  onSave,
  title = 'Edit image',
  description = 'Drag to reposition, scroll or use the slider to zoom. The circle is what gets saved.',
  saveLabel = 'Save',
  shape = 'circle',
}: CircleImageCropperProps) => {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useModalA11y(dialogRef, onCancel)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const drag = useRef<{ startX: number; startY: number; base: Offset } | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setNatural(null)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  // At zoom=1 the image "covers" the stage (shortest side == STAGE); zoom scales
  // up from there. Panning is clamped so the image always fills the circle.
  const coverScale = natural ? Math.max(STAGE / natural.w, STAGE / natural.h) : 1
  const displayW = natural ? natural.w * coverScale * zoom : STAGE
  const displayH = natural ? natural.h * coverScale * zoom : STAGE
  const maxX = Math.max(0, (displayW - STAGE) / 2)
  const maxY = Math.max(0, (displayH - STAGE) / 2)

  const clampOffset = (next: Offset, mx = maxX, my = maxY): Offset => ({
    x: clamp(next.x, -mx, mx),
    y: clamp(next.y, -my, my),
  })

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!natural) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startY: event.clientY, base: offset }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const next = {
      x: drag.current.base.x + (event.clientX - drag.current.startX),
      y: drag.current.base.y + (event.clientY - drag.current.startY),
    }
    setOffset(clampOffset(next))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const applyZoom = (nextZoom: number) => {
    if (!natural) return
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    const mx = Math.max(0, (natural.w * coverScale * z - STAGE) / 2)
    const my = Math.max(0, (natural.h * coverScale * z - STAGE) / 2)
    setZoom(z)
    setOffset((prev) => clampOffset(prev, mx, my))
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!natural) return
    event.preventDefault()
    applyZoom(zoom - event.deltaY * 0.0015)
  }

  const handleSave = () => {
    const img = imgRef.current
    if (!img || !natural) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const f = OUTPUT / STAGE
    const outCover = Math.max(OUTPUT / natural.w, OUTPUT / natural.h)
    const drawW = natural.w * outCover * zoom
    const drawH = natural.h * outCover * zoom
    const dx = OUTPUT / 2 - drawW / 2 + offset.x * f
    const dy = OUTPUT / 2 - drawH / 2 + offset.y * f

    ctx.save()
    ctx.beginPath()
    if (shape === 'circle') {
      ctx.arc(OUTPUT / 2, OUTPUT / 2, OUTPUT / 2, 0, Math.PI * 2)
    } else {
      ctx.roundRect(0, 0, OUTPUT, OUTPUT, ROUNDED_OUTPUT_RADIUS)
    }
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(img, dx, dy, drawW, drawH)
    ctx.restore()

    canvas.toBlob((blob) => {
      if (blob) onSave(blob)
    }, 'image/png')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--scrim-strong)' }}
    >
      <div
        aria-labelledby="cropper-title"
        aria-modal="true"
        className="admin-card w-full max-w-md p-5"
        ref={dialogRef}
        role="dialog"
        style={{ background: 'var(--panel)' }}
        tabIndex={-1}
      >
        <div className="text-base font-semibold text-[color:var(--tx)]" id="cropper-title">
          {title}
        </div>
        <div className="mt-1 text-sm text-[color:var(--tx2)]">{description}</div>

        <div className="mt-4 flex justify-center">
          <div
            className="relative overflow-hidden rounded-xl bg-[color:var(--main)]"
            onPointerCancel={endDrag}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onWheel={handleWheel}
            style={{ height: STAGE, width: STAGE, cursor: natural ? 'grab' : 'default', touchAction: 'none' }}
          >
            {url && (
              <img
                alt=""
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                draggable={false}
                onLoad={(event) => {
                  const el = event.currentTarget
                  setNatural({ w: el.naturalWidth, h: el.naturalHeight })
                }}
                ref={imgRef}
                src={url}
                style={{
                  height: displayH,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  width: displayW,
                }}
              />
            )}
            {/* Semi-transparent mask with a transparent crop cut-out + accent ring. */}
            <div
              aria-hidden="true"
              className={[
                'pointer-events-none absolute left-1/2 top-1/2',
                shape === 'circle' ? 'rounded-full' : 'rounded-[40px]',
              ].join(' ')}
              style={{
                boxShadow: '0 0 0 9999px var(--scrim-strong), inset 0 0 0 2px var(--accent)',
                height: STAGE,
                transform: 'translate(-50%, -50%)',
                width: STAGE,
              }}
            />
          </div>
        </div>

        <label className="mt-4 flex items-center gap-3">
          <span className="text-xs text-[color:var(--tx3)]">Zoom</span>
          <input
            className="flex-1 accent-[color:var(--accent)]"
            disabled={!natural}
            max={MAX_ZOOM}
            min={MIN_ZOOM}
            onChange={(event) => applyZoom(Number(event.target.value))}
            step={0.01}
            type="range"
            value={zoom}
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={busy || !natural}
            onClick={handleSave}
            type="button"
          >
            {busy ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
