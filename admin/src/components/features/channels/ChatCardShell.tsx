import type { ReactNode } from 'react'

/**
 * The one compact surface for a structured item in the channel feed. It is a
 * theme-correct paper surface (`--panel`), not a second nested panel: card
 * bodies use spacing and dividers to show depth.
 */
export const ChatCardShell = ({
  children,
  className = '',
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}) => (
  <section
    className={`chat-card${className ? ` ${className}` : ''}`}
    {...(testId ? { 'data-testid': testId } : {})}
  >
    {children}
  </section>
)
