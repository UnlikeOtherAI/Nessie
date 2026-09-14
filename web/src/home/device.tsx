import type { Shot } from './content'

// A generic all-in-one desktop drawn for Nessie: thin dark bezel, a tinted
// chin, a tapered neck on an oval base. No brand mark, and deliberately not a
// copy of any real product. The screen renders whatever screenshot it is given;
// tilt and zoom live in CSS. `idPrefix` keeps SVG ids unique when the hero and
// the zoomed view render at the same time.

const screen = { x: 40, y: 40, width: 920, height: 575 }

export function Desktop({ shot, idPrefix }: { shot: Shot; idPrefix: string }) {
  const id = (name: string) => `${idPrefix}-${name}`
  return (
    <svg aria-label={shot.alt} className="n-device" role="img" viewBox="0 0 1000 900">
      <defs>
        <linearGradient id={id('shell')} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fbfcfe" />
          <stop offset="0.855" stopColor="#eef2f8" />
          <stop offset="0.856" stopColor="#dbe6fb" />
          <stop offset="1" stopColor="#c6d6f6" />
        </linearGradient>
        <linearGradient id={id('neck')} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#c9d4e8" />
          <stop offset="0.5" stopColor="#e6ecf6" />
          <stop offset="1" stopColor="#bfcbe2" />
        </linearGradient>
        <linearGradient id={id('glare')} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.18" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('screen')}>
          <rect {...screen} rx="4" />
        </clipPath>
        <filter height="3" id={id('blur')} width="1.6" x="-0.3" y="-1">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      <ellipse cx="500" cy="872" fill="#0b172a" filter={`url(#${id('blur')})`} opacity="0.18" rx="300" ry="16" />
      <path d="M452 734 H548 L584 846 H416 Z" fill={`url(#${id('neck')})`} />
      <ellipse cx="500" cy="852" fill="#d5ddec" rx="178" ry="18" />
      <ellipse cx="500" cy="848" fill="#e8edf6" rx="170" ry="13" />

      <rect fill={`url(#${id('shell')})`} height="716" rx="26" stroke="#d3dbe8" strokeWidth="2" width="960" x="20" y="20" />
      <rect fill="#0b172a" height="591" rx="8" width="936" x="32" y="32" />
      <circle cx="500" cy="26" fill="#1b2536" r="3.5" />

      <image
        className="n-screen-img"
        clipPath={`url(#${id('screen')})`}
        href={shot.src}
        key={shot.src}
        preserveAspectRatio="xMidYMid slice"
        {...screen}
      />
      <rect {...screen} fill={`url(#${id('glare')})`} pointerEvents="none" />
    </svg>
  )
}
