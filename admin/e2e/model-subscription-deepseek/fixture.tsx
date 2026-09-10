import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ModelCombobox } from '../../src/components/features/agents/designer/ModelCombobox'
import { ModelSubscriptionSection } from '../../src/pages/settings/connections/ModelSubscriptionSection'
import '../../src/styles.css'

const deepseekProvider = {
  authStrategy: 'api_key' as const,
  displayName: 'DeepSeek API',
  key: 'deepseek',
  models: [{
    description: 'DeepSeek-V4.1-Flash with tool calling.',
    displayName: 'DeepSeek Flash',
    model: 'deepseek-flash',
  }],
  termsNote:
    'Runs against your own DeepSeek API balance, including topped-up or granted balance, not your organisation’s Ledger credits.',
}

const client = {
  delete: async () => undefined,
  get: async (path: string) => {
    if (path === '/api/model-subscriptions/providers') {
      return { available: true, providers: [deepseekProvider] }
    }
    if (path === '/api/model-subscriptions') return []
    throw new Error(`Unexpected GET ${path}`)
  },
  patch: async () => undefined,
  post: async () => undefined,
  put: async () => undefined,
} as unknown as ApiClient

type ModelOption = Parameters<typeof ModelCombobox>[0]['options'][number]

const deepseekOption: ModelOption = {
  description: 'DeepSeek-V4.1-Flash with tool calling.',
  displayName: 'DeepSeek Flash',
  model: 'deepseek-flash',
  modelSubscriptionId: '00000000-0000-4000-8000-000000000001',
  provider: 'subscription/deepseek',
  providerDisplayName: 'DeepSeek API',
  source: 'subscription',
}

const Fixture = () => {
  const [selected, setSelected] = useState<ModelOption | null>(deepseekOption)
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-[color:var(--tx1)]">Connections</h1>
        <ModelSubscriptionSection />
      </div>
      <section className="flex max-w-md flex-col gap-2">
        <h2 className="text-base font-semibold text-[color:var(--tx1)]">Agent Designer</h2>
        <label className="text-sm text-[color:var(--tx2)]" htmlFor="deepseek-agent-model">
          Personal model
        </label>
        <ModelCombobox
          emptyLabel="No models match that search"
          id="deepseek-agent-model"
          onSelect={setSelected}
          options={[deepseekOption]}
          placeholder="Search models…"
          value={selected}
        />
      </section>
    </main>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.')

createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiClientProvider client={client}>
      <Fixture />
    </ApiClientProvider>
  </QueryClientProvider>,
)
