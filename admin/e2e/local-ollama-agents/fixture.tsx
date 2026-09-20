import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'

import { AgentAvailability } from '../../src/components/features/agents/AgentAvailability'
import { AgentModelField } from '../../src/components/features/agents/designer/AgentModelField'
import { LocalInferenceEnablement } from '../../src/components/features/local-inference/LocalInferenceEnablement'
import { LocalInferenceHostStatus } from '../../src/components/features/local-inference/LocalInferenceHostStatus'
import { LocalOllamaSection } from '../../src/pages/settings/connections/LocalOllamaSection'
import type { AgentModelOption } from '../../src/lib/api-client'
import '../../src/styles.css'

const HOST_DESKTOP = '00000000-0000-4000-8000-0000000000d1'
const HOST_EXECUTOR = '00000000-0000-4000-8000-0000000000e1'
const HOST_UNKNOWN = '00000000-0000-4000-8000-0000000000f1'
const AGENT_ONLINE = '00000000-0000-4000-8000-0000000000a1'
const AGENT_OFFLINE = '00000000-0000-4000-8000-0000000000a2'
const AGENT_UNKNOWN = '00000000-0000-4000-8000-0000000000a3'

type Host = {
  availability: 'online' | 'offline' | 'unknown'
  executorId: string | null
  id: string
  lastSeenAt: string | null
  models: Array<{ manifestDigest: string; name: string }>
  paused: boolean
  status: 'active' | 'revoked'
  transport: 'desktop' | 'executor'
}

const hosts: Host[] = [
  {
    availability: 'online', executorId: null, id: HOST_DESKTOP,
    lastSeenAt: '2026-09-20T09:00:00.000Z',
    models: [{ manifestDigest: 'a'.repeat(64), name: 'qwen3:8b' }],
    paused: false, status: 'active', transport: 'desktop',
  },
  {
    availability: 'offline', executorId: 'executor-ollama', id: HOST_EXECUTOR,
    lastSeenAt: '2026-09-20T08:00:00.000Z',
    models: [{ manifestDigest: 'b'.repeat(64), name: 'gemma4:12b' }],
    paused: false, status: 'active', transport: 'executor',
  },
  {
    availability: 'unknown', executorId: 'executor-unknown', id: HOST_UNKNOWN,
    lastSeenAt: null, models: [], paused: false, status: 'active', transport: 'executor',
  },
]

const localOption: AgentModelOption = {
  description: 'Reported by this computer. It stays selected only after this exact computer approves it.',
  displayName: 'Gemma 4 12B',
  localInferenceHostId: HOST_EXECUTOR,
  localManifestDigest: 'b'.repeat(64),
  model: 'gemma4:12b',
  provider: 'local/ollama',
  providerDisplayName: 'Local Ollama',
  source: 'local',
}

let statusReads = 0
let teamEnabled = false
const calls: Array<{ body?: unknown; method: string; path: string }> = []

const availability = (agentId: string) => ({
  availability: agentId === AGENT_ONLINE ? 'online' : agentId === AGENT_OFFLINE ? 'offline' : 'unknown',
  reason: agentId === AGENT_ONLINE ? 'ready' : agentId === AGENT_OFFLINE ? 'host_offline' : 'authority_unavailable',
  revision: 1,
  serverTime: '2026-09-20T10:00:00.000Z',
  validUntil: '2026-09-20T10:01:00.000Z',
})

const client = {
  delete: async (path: string) => { calls.push({ method: 'DELETE', path }) },
  get: async (path: string) => {
    calls.push({ method: 'GET', path })
    if (path === '/api/local-inference/hosts') return { hosts, meta: { total: hosts.length } }
    if (path.includes('/availability')) return availability(path.split('/')[3] ?? '')
    if (path.includes('/local-inference/bindings/')) {
      statusReads += 1
      return { bindingId: 'binding-exact', status: statusReads > 1 ? 'consented_pending_activation' : 'pending' }
    }
    if (path.startsWith('/api/settings/scoped?')) {
      const params = new URLSearchParams(path.split('?')[1])
      const scope = params.get('scope')
      const setting = scope === 'team'
        ? { canEdit: true, key: 'inference.localAgents.enabled', lockedAtScope: null, lockedHere: false, setAtScope: 'team', value: teamEnabled }
        : { canEdit: false, key: 'inference.localAgents.enabled', lockedAtScope: 'team', lockedHere: false, setAtScope: 'team', value: true }
      return { settings: [setting] }
    }
    throw new Error(`Unexpected GET ${path}`)
  },
  patch: async (path: string, body: unknown) => { calls.push({ body, method: 'PATCH', path }) },
  post: async (path: string, body: unknown) => {
    calls.push({ body, method: 'POST', path })
    if (path.endsWith('/local-inference/prepare')) {
      return { bindingId: 'binding-exact', challengeId: 'challenge-exact', expiresAt: '2026-09-20T11:00:00.000Z' }
    }
    const host = hosts.find((candidate) => path.includes(candidate.id))
    if (host && /\/(pause|resume|revoke)$/.test(path)) return undefined
    throw new Error(`Unexpected POST ${path}`)
  },
  put: async (path: string, body: unknown) => {
    calls.push({ body, method: 'PUT', path })
    if (path.endsWith('/inference.localAgents.enabled') && body && typeof body === 'object' && 'value' in body) {
      teamEnabled = (body as { value: unknown }).value === true
    }
    return { settings: [] }
  },
} as unknown as ApiClient

declare global {
  interface Window { localOllamaFixtureCalls: typeof calls }
}
window.localOllamaFixtureCalls = calls

const Designer = () => {
  const [bindingId, setBindingId] = useState<string | null>(null)
  const [selected, setSelected] = useState<AgentModelOption>(localOption)
  return (
    <section className="grid gap-3 rounded-xl border border-[color:var(--sep)] p-4" data-testid="designer">
      <h2 className="text-lg font-semibold">Agent Designer · Model</h2>
      <AgentModelField
        agentId="agent-exact"
        disabled={false}
        error={undefined}
        loading={false}
        model={selected.model}
        onLocalBindingChange={setBindingId}
        onSelect={setSelected}
        options={[localOption]}
        provider={selected.provider}
        selected={selected}
        streaming={false}
      />
      <button className="admin-button admin-button-primary w-fit" disabled={!bindingId} type="button">
        Save agent
      </button>
    </section>
  )
}

const Presence = () => (
  <section className="grid gap-3 rounded-xl border border-[color:var(--sep)] p-4">
    <h2 className="text-lg font-semibold">Agents</h2>
    <div className="grid gap-2" data-testid="agent-list">
      <p>Online local agent <AgentAvailability agentId={AGENT_ONLINE} canRepair localBindingId="binding-online" provider="local/ollama" /></p>
      <p>Offline local agent <AgentAvailability agentId={AGENT_OFFLINE} canRepair localBindingId="binding-offline" provider="local/ollama" /></p>
    </div>
    <div className="border-t border-[color:var(--sep)] pt-3" data-testid="agent-detail">
      <h3 className="font-medium">Unknown local agent</h3>
      <AgentAvailability agentId={AGENT_UNKNOWN} canRepair localBindingId="binding-unknown" provider="local/ollama" />
    </div>
  </section>
)

const Fixture = () => (
  <main className="mx-auto grid max-w-4xl gap-5 p-5 text-[color:var(--tx)]">
    <header>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">Local inference verification</p>
      <h1 className="text-2xl font-semibold">Local Ollama agents</h1>
    </header>
    <section className="grid gap-3 rounded-xl border border-[color:var(--sep)] p-4" data-testid="connections">
      <h2 className="text-lg font-semibold">Connected accounts · Local Ollama</h2>
      <LocalOllamaSection />
    </section>
    <section className="grid gap-3 rounded-xl border border-[color:var(--sep)] p-4" data-testid="executor-detail">
      <h2 className="text-lg font-semibold">Paired executor · Local Ollama</h2>
      <LocalInferenceHostStatus executorId="executor-ollama" empty={<p>No local Ollama host.</p>} />
    </section>
    <Designer />
    <Presence />
    <section className="grid gap-5 rounded-xl border border-[color:var(--sep)] p-4" data-testid="policy">
      <h2 className="text-lg font-semibold">Models · Local Ollama policy</h2>
      <LocalInferenceEnablement scope="team" teamId="team-design" />
      <LocalInferenceEnablement scope="user" userId="user-locked" />
    </section>
  </main>
)

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiClientProvider client={client}>
      <MemoryRouter><Fixture /></MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
