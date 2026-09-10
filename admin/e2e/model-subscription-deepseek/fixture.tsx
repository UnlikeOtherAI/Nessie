import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ModelCombobox } from '../../src/components/features/agents/designer/ModelCombobox'
import { ModelSubscriptionSection } from '../../src/pages/settings/connections/ModelSubscriptionSection'
import '../../src/styles.css'

/**
 * The verbatim `/api/model-subscriptions/providers` payload, which the route
 * builds from `listSubscriptionAdapters()`. DeepSeek is checked as the fifth
 * entry beside the four that already shipped, not on a page of its own: the
 * failure this fixture guards against is an adapter that registers but never
 * reaches the connections page a person actually opens.
 */
const providers = [
  {
    authStrategy: 'api_key' as const,
    displayName: 'DeepSeek API',
    key: 'deepseek',
    models: [{
      description: 'DeepSeek-V4.1-Flash with tool calling.',
      displayName: 'DeepSeek Flash',
      model: 'deepseek-flash',
    }],
    termsNote:
      'Runs against your own DeepSeek API balance, including topped-up or granted balance, not your organisation’s Ledger credits. Nessie stores the key securely so your agents can use it while you are away.',
  },
  {
    authStrategy: 'api_key' as const,
    displayName: 'GLM Coding Plan',
    key: 'glm',
    models: [
      { description: 'Z.ai’s flagship GLM model.', displayName: 'GLM-4.6', model: 'glm-4.6' },
      { description: 'Faster, lighter GLM.', displayName: 'GLM-4.5-Air', model: 'glm-4.5-air' },
    ],
    termsNote:
      'Runs on your own GLM coding plan and counts against your personal usage limits, not your organisation’s credits. Nessie stores the key so your agents can use it while you are away.',
  },
  {
    authStrategy: 'oauth_device' as const,
    displayName: 'Grok (SuperGrok)',
    key: 'grok',
    models: [
      { description: 'xAI’s flagship Grok model.', displayName: 'Grok 4', model: 'grok-4' },
      {
        description: 'Fast Grok model for coding.',
        displayName: 'Grok Code Fast',
        model: 'grok-code-fast-1',
      },
    ],
    termsNote:
      'Signs in to your own xAI account and runs against your SuperGrok plan’s limits, not your organisation’s credits. xAI may show “Grok Build” on the consent screen, because Nessie uses xAI’s shared sign-in app. Your account needs an eligible subscription.',
  },
  {
    authStrategy: 'api_key' as const,
    displayName: 'Kimi for Coding',
    key: 'kimi',
    models: [{
      description: 'Kimi’s coding-plan model.',
      displayName: 'Kimi for Coding',
      model: 'kimi-for-coding',
    }],
    termsNote:
      'Runs on your own Kimi for Coding plan and counts against your personal usage limits, not your organisation’s credits. Nessie stores the key so your agents can use it while you are away.',
  },
  {
    authStrategy: 'oauth_device' as const,
    displayName: 'ChatGPT Codex',
    key: 'openai_codex',
    models: [{
      description: 'OpenAI’s Codex model.',
      displayName: 'GPT-5 Codex',
      model: 'gpt-5-codex',
    }],
    termsNote:
      'Signs in to your own ChatGPT account and runs against your plan’s limits, not your organisation’s credits. Nessie keeps its own sign-in, separate from the Codex CLI, so the two never sign each other out. Check that your plan permits use from other tools.',
  },
]

const client = {
  delete: async () => undefined,
  get: async (path: string) => {
    if (path === '/api/model-subscriptions/providers') return { available: true, providers }
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
