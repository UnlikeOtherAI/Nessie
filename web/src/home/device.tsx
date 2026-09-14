import type { Shot } from './content'

// An all-in-one desktop in the owner's reference style: a white bezel around a
// 16:10 screen, a deep tinted chin, and a straight flat slab stand on a thin
// flat foot. No logo. The screen renders whatever screenshot it is given; tilt
// and zoom live in CSS. `idPrefix` keeps SVG ids unique when the hero and the
// zoomed view render at the same time.

const body = { x: 20, y: 20, width: 960, height: 728, rx: 22 }
const screen = { x: 44, y: 44, width: 912, height: 570 } // exactly 16:10
const chinTop = 638
// A wide straight slab; the foot plate's top face is seen slightly from above,
// so it widens towards the viewer, with a thin darker front edge.
const neck = { x: 405, y: 740, width: 190, height: 102 }
const footTop = 'M398 842 H602 L614 864 H386 Z'
const footEdge = { x: 386, y: 864, width: 228, height: 6 }

export function Desktop({ shot, idPrefix }: { shot: Shot; idPrefix: string }) {
  const id = (name: string) => `${idPrefix}-${name}`
  const url = (name: string) => `url(#${id(name)})`
  return (
    <svg aria-label={shot.alt} className="n-device" role="img" viewBox="0 0 1000 900">
      <defs>
        <linearGradient id={id('bezel')} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f2f4f8" />
        </linearGradient>
        <linearGradient id={id('chin')} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#dce8fd" />
          <stop offset="1" stopColor="#c8dafb" />
        </linearGradient>
        <linearGradient id={id('neck')} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#b9c8e6" />
          <stop offset="0.12" stopColor="#d6e2f8" />
          <stop offset="0.5" stopColor="#e4ecfb" />
          <stop offset="0.88" stopColor="#d2def5" />
          <stop offset="1" stopColor="#b3c3e2" />
        </linearGradient>
        <linearGradient id={id('neck-shade')} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0b172a" stopOpacity="0.22" />
          <stop offset="0.3" stopColor="#0b172a" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('foot')} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#eef3fc" />
          <stop offset="0.45" stopColor="#d3dff5" />
          <stop offset="1" stopColor="#aebfdf" />
        </linearGradient>
        <linearGradient id={id('glare')} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('body')}>
          <rect {...body} />
        </clipPath>
        <clipPath id={id('screen')}>
          <rect {...screen} rx="2" />
        </clipPath>
        <filter height="5" id={id('soft')} width="1.8" x="-0.4" y="-2">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      {/* Floor shadow under the foot */}
      <ellipse cx="500" cy="876" fill="#0b172a" filter={url('soft')} opacity="0.24" rx="170" ry="8" />

      {/* Straight slab stand on a flat foot plate */}
      <rect {...neck} fill={url('neck')} />
      <rect {...neck} fill={url('neck-shade')} />
      <path d={footTop} fill={url('foot')} />
      <rect {...footEdge} fill="#a3b5d8" rx="2" />
      <path d="M398 842 H602" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1.5" />

      {/* Body: white bezel on top, tinted chin below */}
      <rect {...body} fill={url('bezel')} />
      <rect clipPath={url('body')} fill={url('chin')} height={body.y + body.height - chinTop} width={body.width}
        x={body.x} y={chinTop} />
      <rect {...body} fill="none" stroke="#c9d5ea" strokeWidth="1.5" />
      <circle cx="500" cy="32" fill="#2a3446" r="3.5" />

      {/* Screen with a hairline edge and a soft glare */}
      <rect {...screen} fill="#0b172a" />
      <image
        className="n-screen-img"
        clipPath={url('screen')}
        href={shot.src}
        key={shot.src}
        preserveAspectRatio="xMidYMid slice"
        {...screen}
      />
      <rect {...screen} fill={url('glare')} pointerEvents="none" />
      <rect {...screen} fill="none" stroke="#0b172a" strokeOpacity="0.18" strokeWidth="1.5" />
    </svg>
  )
}
