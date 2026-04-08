import type { PropsWithChildren } from 'react'

export const ThemeProvider = ({ children }: PropsWithChildren) => (
  <div className="min-h-screen text-[var(--ink)]">{children}</div>
)
