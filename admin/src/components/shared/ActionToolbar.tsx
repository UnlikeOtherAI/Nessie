import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react'

export const SharedActionButton = ({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...props} className={['admin-msg-action-button', className].filter(Boolean).join(' ')} />
)

type SharedActionToolbarProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
}

export const SharedActionToolbar = ({
  children,
  className = '',
  ...props
}: SharedActionToolbarProps) => (
  <div {...props} className={['admin-msg-actions', className].filter(Boolean).join(' ')}>
    {children}
  </div>
)
