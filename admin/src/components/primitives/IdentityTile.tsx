import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { identityTileRadius } from '../../lib/identity-shape'

/**
 * What is drawn when there is no picture. Every identity has one — an absent
 * avatar is the ordinary case (roughly half the app catalogue, every agent
 * before its portrait generates, every person who never uploaded one), not an
 * error state.
 */
export type IdentityFallback =
  | { kind: 'initials'; text: string }
  | { kind: 'glyph'; glyph: string }
  | { kind: 'icon'; icon: ReactNode }

export type IdentityTileProps = {
  /** Rendered edge length in pixels. Drives the corner radius too. */
  size: number
  /**
   * The already-resolved picture. Callers hand this in from one of the
   * `use*AvatarUrl` hooks — this component never decides *which* source wins,
   * only how the winner is drawn.
   */
  imageUrl: string | null
  fallback: IdentityFallback
  /** Accessible name for the picture; also the image `alt`. */
  label: string
  background?: string
  color?: string
  /** Contain for app marks and logos, cover for photographs. */
  fit?: 'contain' | 'cover'
  /** Inset applied to a contained image so a mark is not flush to the edge. */
  pad?: number
  border?: boolean
  muted?: boolean
  className?: string
  style?: CSSProperties
}

const fallbackFontSize = (size: number, kind: IdentityFallback['kind']): number =>
  Math.max(9, Math.round(size * (kind === 'glyph' ? 0.5 : 0.38)))

/**
 * The single identity picture renderer for the admin: people, agents,
 * projects, teams/teams and apps all end here.
 *
 * It owns exactly three things, which is why it exists: the shape (one
 * proportional rounded square, see identity-shape.ts), the broken-image reset
 * (four primitives used to repeat it, and each reset on a different dependency),
 * and the fallback. Everything above it — precedence between UnlikeOtherAI, a
 * local attachment and a provider URL, which relay serves the bytes, which
 * palette colours an agent — stays in the resolving hooks, so a call site can
 * never assemble a fifth variant of the tile by hand.
 */
export const IdentityTile = ({
  size,
  imageUrl,
  fallback,
  label,
  background,
  color,
  fit = 'cover',
  pad = 0,
  border = false,
  muted = false,
  className,
  style,
}: IdentityTileProps) => {
  const [broken, setBroken] = useState(false)

  // Reset whenever the source changes: an authed relay resolving after a
  // provider picture failed must still get its chance to render.
  useEffect(() => setBroken(false), [imageUrl])

  const showImage = Boolean(imageUrl) && !broken

  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex flex-shrink-0 items-center justify-center overflow-hidden',
        'font-semibold leading-none',
        border ? 'border border-[color:var(--line)]' : '',
        muted ? 'opacity-60' : '',
        className ?? '',
      ].join(' ')}
      style={{
        width: size,
        height: size,
        borderRadius: identityTileRadius(size),
        background,
        color,
        fontSize: fallbackFontSize(size, fallback.kind),
        ...style,
      }}
    >
      {showImage ? (
        <img
          alt={label}
          className="h-full w-full"
          onError={() => setBroken(true)}
          src={imageUrl ?? undefined}
          style={{ objectFit: fit, padding: pad || undefined }}
        />
      ) : fallback.kind === 'icon' ? (
        fallback.icon
      ) : (
        <span>{fallback.kind === 'glyph' ? fallback.glyph : fallback.text}</span>
      )}
    </span>
  )
}
