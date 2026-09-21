import type { CSSProperties, ReactNode } from 'react'
import { faLink, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

export type LabelPillSize = 'md' | 'sm'

type LabelPillProps = {
  /** `#rrggbb` — the label's own colour, which is data, not a theme token. */
  color: string
  /** Source-owned (a board source names it); shows the source glyph. */
  external?: boolean
  /** Replaces the default source glyph — the provider's own mark. */
  externalGlyph?: ReactNode
  name: string
  /** Draws a × that calls this; its accessible name is "Remove <name>". */
  onRemove?: () => void
  size?: LabelPillSize
  title?: string
}

/** A colour the stylesheet may mix; anything else falls back to the text grey. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * A project label as a pill.
 *
 * The one place colour-as-data is allowed in the admin: the label's hex rides
 * in as the inline custom property `--label`, and `.admin-label-pill` in
 * `styles.css` mixes it into the surface for the fill and the border and uses
 * it neat only for the 6 px dot. The text is always `--tx`, so contrast holds
 * by construction on every theme whatever colour a person picked — no class
 * ever carries the hex.
 */
export const LabelPill = ({
  color,
  external = false,
  externalGlyph,
  name,
  onRemove,
  size = 'md',
  title,
}: LabelPillProps) => {
  const style = (HEX_COLOR.test(color) ? { '--label': color } : {}) as CSSProperties
  return (
    <span
      className={`admin-label-pill admin-label-pill-${size}`}
      data-external={external ? 'true' : undefined}
      style={style}
      title={title}
    >
      <span aria-hidden="true" className="admin-label-pill-dot" />
      {external ? (
        <span aria-hidden="true" className="admin-label-pill-glyph">
          {externalGlyph ?? <FontAwesomeIcon icon={faLink} />}
        </span>
      ) : null}
      <span className="admin-label-pill-name">{name}</span>
      {onRemove ? (
        <button
          aria-label={`Remove ${name}`}
          className="admin-label-pill-remove"
          // Keep focus in the field the pill sits in.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          tabIndex={-1}
          type="button"
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      ) : null}
    </span>
  )
}
