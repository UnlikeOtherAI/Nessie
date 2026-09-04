import { createRoot } from 'react-dom/client'

import { ExecutorDesktopCompanionPanel } from '../../src/components/features/executors/ExecutorDesktopCompanionPanel'
import { ShellEnvironmentProvider } from '../../src/providers/ShellEnvironmentProvider'
import '../../src/styles.css'

export const EXECUTOR_FIXTURE_ID = '00000000-0000-4000-8000-000000000701'

const Fixture = () => (
  <ShellEnvironmentProvider>
    <main className="min-h-screen bg-[color:var(--bg)] p-8 text-[color:var(--tx)]">
      <div className="mx-auto grid max-w-4xl gap-4">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
            Agents
          </p>
          <h1 className="text-2xl font-semibold">Executors</h1>
          <p className="mt-1 text-sm text-[color:var(--tx3)]">
            Pair governed work with the Windows computer in front of you.
          </p>
        </header>
        <ExecutorDesktopCompanionPanel executorId={EXECUTOR_FIXTURE_ID} />
      </div>
    </main>
  </ShellEnvironmentProvider>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor companion fixture root is missing.')
createRoot(root).render(<Fixture />)
