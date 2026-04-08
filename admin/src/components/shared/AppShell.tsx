import type { PropsWithChildren, ReactNode } from 'react'

type AppShellProps = PropsWithChildren<{
  activity: ReactNode
  rail: ReactNode
}>

export const AppShell = ({ activity, children, rail }: AppShellProps) => (
  <div className="min-h-screen px-4 py-4 md:px-6">
    <div className="mx-auto flex max-w-[1720px] gap-4">
      <aside
        className={[
          'sticky top-4 hidden h-[calc(100vh-2rem)] w-24 flex-shrink-0',
          'self-start rounded-[2rem] border border-[color:var(--line)]',
          'bg-white/70 p-3',
          'xl:flex xl:flex-col xl:gap-3',
        ].join(' ')}
      >
        {rail}
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
      <aside
        className={[
          'sticky top-4 hidden h-[calc(100vh-2rem)] w-[360px] flex-shrink-0',
          'self-start overflow-hidden',
          'xl:block',
        ].join(' ')}
      >
        {activity}
      </aside>
    </div>
  </div>
)
