import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { Popover } from '../../src/components/overlays/Popover'
import { ExecutorSection } from '../../src/layouts/admin-shell/user-menu/ExecutorSection'
import { useExecutorRealtime } from '../../src/facades/executors/realtime'
import { useExecutors } from '../../src/facades/executors/hooks'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const organizationId = '22222222-2222-4222-8222-222222222222'
const client = createApiClient({ baseUrl: '', token: 'executor-menu-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const topbar = new URLSearchParams(location.search).has('topbar')
const Fixture = () => {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const location = useLocation()
  const inventory = useExecutors()
  useExecutorRealtime('executor-menu-fixture', organizationId)
  return <main className="h-screen bg-[color:var(--main)] p-4 text-[color:var(--tx)]">
    <button className="admin-button" onClick={() => setOpen((value) => !value)} ref={anchor}
      style={{ position: 'fixed', ...(topbar ? { right: 12, top: 12 } : { left: 12, bottom: 12 }) }}
      type="button">Account</button>
    <output aria-label="Current route">{location.pathname}{location.search}</output>
    <ul aria-label="Inventory">{inventory.data?.map((executor) => <li key={executor.id}>{executor.label}: {executor.status}</li>)}</ul>
    <Popover anchorRef={anchor} className="w-[252px] rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5"
      label="Account menu" onClose={() => setOpen(false)} open={open} placement={topbar ? 'bottom-end' : 'right'} role="menu">
      <ExecutorSection onClose={() => setOpen(false)} />
    </Popover>
  </main>
}
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor menu fixture is missing.')
createRoot(root).render(<QueryClientProvider client={queries}><ApiClientProvider client={client}>
  <BrowserRouter><LocalBackProvider><Fixture /></LocalBackProvider></BrowserRouter>
</ApiClientProvider></QueryClientProvider>)
