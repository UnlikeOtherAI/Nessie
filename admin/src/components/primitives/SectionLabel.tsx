import type { ReactNode } from 'react'

/**
 * The three elements the shipping labels actually render as: a plain `div` by
 * default, `h2` where the label is the real heading of a section, and `span`
 * where it sits inline inside another block.
 */
export type SectionLabelElement = 'div' | 'h2' | 'span'

/**
 * Named for the type scale each one renders, so the smaller name is the
 * smaller label: `xs` is 12px, `2xs` is 11px.
 *
 * `sm` is 12px at `0.16em`, added 2026-09-01. It is not a fourth taste: that
 * exact string — `text-xs font-semibold uppercase tracking-[0.16em]
 * text-[color:var(--tx3)]` — was hand-typed in 29 files, and three more files
 * carried the same verbatim comment explaining that this component could not
 * express the tracking they needed. It is the admin's most-shipped label and
 * had no home; now it does. `xs` (0.2em) stays the default because that is
 * what this component's existing 54 call sites render.
 */
export type SectionLabelSize = '2xs' | 'sm' | 'xs'

type SectionLabelProps = {
  as?: SectionLabelElement
  children: ReactNode
  className?: string
  size?: SectionLabelSize
}

const sizeClasses: Record<SectionLabelSize, string> = {
  '2xs': 'text-[11px] tracking-[0.18em]',
  sm: 'text-xs tracking-[0.16em]',
  xs: 'text-xs tracking-[0.2em]',
}

/**
 * The dim, wide-tracked, uppercase heading that names a block of a page — one
 * of exactly two treatments, and nothing else.
 *
 * This is the atom for *one* string, not for uppercase labels in general. A
 * label that shipped at another tracking, another weight or another colour is
 * a different label and stays written out where it lives: a `size`/`tone` prop
 * per variant would turn a predictable primitive into a lookup table, and the
 * pass that first tried it silently re-spaced `tracking-wide` labels eightfold
 * and bolded regular-weight ones.
 */
export const SectionLabel = ({
  as: Element = 'div',
  children,
  className,
  size = 'xs',
}: SectionLabelProps) => (
  <Element
    className={[
      'font-semibold uppercase text-[color:var(--tx3)]',
      sizeClasses[size],
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {children}
  </Element>
)
