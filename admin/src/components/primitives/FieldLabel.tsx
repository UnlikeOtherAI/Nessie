import type { ReactNode } from 'react'

/**
 * The label above a form control.
 *
 * Four spellings of this shipped side by side — bare text inside a wrapping
 * `<label>`, a `<span>` inside one, an `htmlFor`/`id` pair with an uppercase
 * micro-label, and several controls with no visible label at all — plus two
 * constants both named `fieldLabelClass` holding different values. This is the
 * uppercase micro-label, the one the dialogs and the designer already used,
 * at {@link SectionLabel}'s `sm` tracking so form labels and section headings
 * sit on the same scale.
 *
 * It always renders a real `<label htmlFor>`. An `aria-label` on the control
 * is not a substitute: it leaves nothing to click and nothing to read beside
 * the field.
 */

type FieldLabelProps = {
  children: ReactNode
  className?: string
  htmlFor: string
  /**
   * Marks the field required, visibly and in the accessibility tree. The admin
   * had no required marker anywhere, so a person met the requirement only as a
   * button that would not respond.
   */
  required?: boolean
}

export const FieldLabel = ({ children, className, htmlFor, required = false }: FieldLabelProps) => (
  <label
    className={[
      'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
    htmlFor={htmlFor}
  >
    {children}
    {required ? (
      <span className="ml-1 text-[color:var(--danger-text)]" title="Required">
        *
      </span>
    ) : null}
  </label>
)
