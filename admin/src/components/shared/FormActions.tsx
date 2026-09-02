import type { ReactNode } from 'react'
import { Notice } from '../primitives/Notice'

/**
 * The row a form ends with.
 *
 * Four placements shipped for the same "commit this form" job: bottom-right in
 * dialogs, bottom-left in page forms, a wrapped row mixing Save with Test and
 * Remove, and one form whose Save lived in the page header. The rule is now
 * one: **actions are right-aligned, the primary action is rightmost, and
 * Cancel sits to its left only when there is an edit to discard.**
 *
 * A form whose Save already lives in a page header keeps it there — headers
 * belong to the navigation surface, and this component does not reach into
 * them.
 */

type FormActionsProps = {
  children: ReactNode
  className?: string
  /**
   * A destructive action that belongs to the record rather than to the form —
   * "Delete channel" beside "Save". It is pinned to the left edge so it can
   * never be hit on the way to the primary action.
   */
  destructive?: ReactNode
}

export const FormActions = ({ children, className, destructive }: FormActionsProps) => (
  <div
    className={[
      'flex items-center gap-2 pt-1',
      destructive ? 'justify-between' : 'justify-end',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {destructive ? <div className="flex items-center gap-2">{destructive}</div> : null}
    <div className="flex items-center gap-2">{children}</div>
  </div>
)

type FormErrorProps = {
  children?: ReactNode
  className?: string
}

/**
 * The whole form failed — a rejected submit, a mutation that came back 500.
 *
 * Distinct from a field error, which names one control. This renders nothing
 * when there is no message, so a call site writes it unconditionally and can
 * no longer forget the failure path: four forms swallowed their mutation
 * errors entirely and simply appeared to do nothing when they failed.
 */
export const FormError = ({ children, className }: FormErrorProps) => {
  if (!children) return null

  return (
    <Notice className={className} role="alert" size="sm" tone="danger">
      {children}
    </Notice>
  )
}

type FormSuccessProps = {
  children?: ReactNode
  className?: string
}

/**
 * The counterpart nothing had: a form that saved says so.
 *
 * Almost no successful mutation in the admin announced itself — a dialog
 * closed, a list refetched, and a person inferred. `role="status"` rather than
 * `alert`: it waits for a pause instead of interrupting.
 */
export const FormSuccess = ({ children, className }: FormSuccessProps) => {
  if (!children) return null

  return (
    <Notice className={className} role="status" size="sm" tone="success">
      {children}
    </Notice>
  )
}
