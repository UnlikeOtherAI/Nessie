import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useFormFieldControl } from './FormField'

/**
 * The three text controls, as components rather than as a class name.
 *
 * `.admin-input` was well adopted — and six surfaces still re-derived it by
 * hand (`AppSearchInput`, `AppCategorySelect`, `AddWidgetPanel`,
 * `MemberManagementPopup`'s search, the knowledge new-folder field,
 * `DashboardsPage`'s search), each landing on a different radius and losing
 * the focus ring. The class is also unlayered, so a call site that adds
 * `py-1` or `text-xs` gets nothing: `TodoInstanceCard` carried an inert
 * `text-xs` for exactly this reason. A `size` prop makes that class of mistake
 * unrepresentable.
 *
 * Each control reads its id and its `aria-invalid`/`aria-describedby` from
 * {@link FormField} when it is inside one, so the accessibility wiring cannot
 * be forgotten and cannot be got wrong.
 */

export type ControlSize = 'compact' | 'default'

/**
 * `compact` is `.admin-input-compact` (30px, aligned to `.admin-button-compact`),
 * for a control sitting inline in a row rather than in a form column. It
 * absorbs `.admin-input-sm`, which had one caller and no rule distinguishing
 * it.
 */
const sizeClasses: Record<ControlSize, string> = {
  compact: 'admin-input-compact',
  default: '',
}

const controlClass = (size: ControlSize, mono: boolean, className?: string): string =>
  ['admin-input', sizeClasses[size], mono ? 'admin-input-mono' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

type SharedProps = {
  className?: string
  mono?: boolean
  size?: ControlSize
}

type InputProps = SharedProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>


export const Input = ({ className, mono = false, size = 'default', ...rest }: InputProps) => {
  const field = useFormFieldControl()

  return (
    <input
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={controlClass(size, mono, className)}
      id={field?.id}
      {...rest}
    />
  )
}

// `size` is omitted from the native attributes on both `input` and `select`
// because each declares its own numeric `size`, and intersecting that with the
// density union would resolve to `never`.
type SelectProps = SharedProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>

export const Select = ({ className, mono = false, size = 'default', ...rest }: SelectProps) => {
  const field = useFormFieldControl()

  return (
    <select
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={controlClass(size, mono, className)}
      id={field?.id}
      {...rest}
    />
  )
}

type TextareaProps = SharedProps & TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = ({
  className,
  mono = false,
  size = 'default',
  ...rest
}: TextareaProps) => {
  const field = useFormFieldControl()

  return (
    <textarea
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={controlClass(size, mono, className)}
      id={field?.id}
      {...rest}
    />
  )
}
