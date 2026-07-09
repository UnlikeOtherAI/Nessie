import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  DeepWaterResearchDepth,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { useLaunchDeepWaterResearch } from '../../../facades/integrations/hooks'

const depthOptions: Array<{ label: string; value: DeepWaterResearchDepth }> = [
  { label: 'Light', value: 'light' },
  { label: 'Standard', value: 'standard' },
  { label: 'Deep', value: 'deep' },
  { label: 'Heavy', value: 'heavy' },
  { label: 'Thesis', value: 'thesis' },
  { label: 'Dissertation', value: 'dissertation' },
]

const readinessClass = (ready: boolean): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    ready
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  ].join(' ')

const money = (amount: number, currency: string): string =>
  new Intl.NumberFormat(undefined, {
    currency,
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(amount)

const boundedInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)))

export const DeepWaterResearchPanel = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const launch = useLaunchDeepWaterResearch()
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState<DeepWaterResearchDepth>('standard')
  const [chapterDepth, setChapterDepth] = useState('standard')
  const [outputTier, setOutputTier] = useState('full')
  const [outputLanguage, setOutputLanguage] = useState('en')
  const [searchQuality, setSearchQuality] = useState('standard')
  const [recency, setRecency] = useState('any')
  const [sections, setSections] = useState(8)
  const [searchesPerPillar, setSearchesPerPillar] = useState(4)
  const [artifactDestination, setArtifactDestination] = useState('knowledge_draft')
  const teamReady = product.teamEnablement?.enabled === true
  const connectorReady = product.mcpInstallation?.lifecycleState === 'active'
  const ready = teamReady && connectorReady
  const canSubmit = ready && query.trim().length > 0 && !launch.isPending
  const lastUsed = product.usageSummary.lastUsedAt
    ? new Date(product.usageSummary.lastUsedAt).toLocaleString()
    : 'No usage yet'

  const submit = async () => {
    if (!canSubmit) return
    const response = await launch.mutateAsync({
      artifactDestination: artifactDestination as 'knowledge_draft' | 'chat_only',
      chapterDepth: chapterDepth as 'brief' | 'standard' | 'detailed' | 'exhaustive',
      depth,
      outputLanguage: outputLanguage.trim() || 'en',
      outputTier: outputTier as 'summary' | 'full',
      query: query.trim(),
      recency: recency as 'any' | 'day' | 'week' | 'month' | 'year',
      searchQuality: searchQuality as 'standard' | 'premium',
      searchesPerPillar: boundedInt(searchesPerPillar, 1, 20),
      sections: boundedInt(sections, 3, 20),
      title: title.trim() || undefined,
    })
    navigate(`/channels/${response.channel.id}`)
  }

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Deep Water research</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={readinessClass(teamReady)}>
              {teamReady ? 'Team enabled' : 'Team disabled'}
            </span>
            <span className={readinessClass(connectorReady)}>
              {connectorReady ? 'MCP active' : 'MCP setup required'}
            </span>
            <span className={readinessClass(product.accountLink?.status === 'linked')}>
              {product.accountLink?.status === 'linked' ? 'Account linked' : 'Account pending'}
            </span>
          </div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2 text-right">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Month to date</div>
          <div className="mt-1 text-sm font-semibold text-[var(--tx)]">
            {money(product.usageSummary.totalCost, product.usageSummary.currency)}
          </div>
          <div className="text-xs text-[var(--tx3)]">{product.usageSummary.totalCalls} calls</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Title</span>
          <input
            className="admin-input"
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Optional"
            value={title}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Research prompt</span>
          <textarea
            className="admin-input min-h-28 resize-y"
            maxLength={5000}
            onChange={(event) => setQuery(event.target.value)}
            value={query}
          />
        </label>

        <div>
          <div className="mb-2 text-sm font-semibold text-[var(--tx2)]">Depth</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {depthOptions.map((option) => (
              <button
                className={[
                  'h-9 rounded border px-2 text-xs font-semibold',
                  depth === option.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'
                    : 'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]',
                ].join(' ')}
                key={option.value}
                onClick={() => setDepth(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Chapter detail</span>
            <select
              className="admin-input"
              onChange={(event) => setChapterDepth(event.target.value)}
              value={chapterDepth}
            >
              <option value="brief">Brief</option>
              <option value="standard">Standard</option>
              <option value="detailed">Detailed</option>
              <option value="exhaustive">Exhaustive</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Output</span>
            <select
              className="admin-input"
              onChange={(event) => setOutputTier(event.target.value)}
              value={outputTier}
            >
              <option value="full">Full report</option>
              <option value="summary">Summary</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Search quality</span>
            <select
              className="admin-input"
              onChange={(event) => setSearchQuality(event.target.value)}
              value={searchQuality}
            >
              <option value="standard">Standard</option>
              <option value="premium">Premium</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Recency</span>
            <select
              className="admin-input"
              onChange={(event) => setRecency(event.target.value)}
              value={recency}
            >
              <option value="any">Any</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Sections</span>
            <input
              className="admin-input"
              max={20}
              min={3}
              onChange={(event) => setSections(Number(event.target.value))}
              type="number"
              value={sections}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Searches per pillar</span>
            <input
              className="admin-input"
              max={20}
              min={1}
              onChange={(event) => setSearchesPerPillar(Number(event.target.value))}
              type="number"
              value={searchesPerPillar}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Language</span>
            <input
              className="admin-input"
              maxLength={12}
              onChange={(event) => setOutputLanguage(event.target.value)}
              value={outputLanguage}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Destination</span>
            <select
              className="admin-input"
              onChange={(event) => setArtifactDestination(event.target.value)}
              value={artifactDestination}
            >
              <option value="knowledge_draft">Knowledge draft</option>
              <option value="chat_only">Chat only</option>
            </select>
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sep)] pt-3">
        <div className="text-xs text-[var(--tx3)]">
          Last activity: {lastUsed}
        </div>
        <button
          className="admin-button admin-button-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {launch.isPending ? 'Starting...' : 'Run research'}
        </button>
      </div>
      {launch.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {launch.error instanceof Error ? launch.error.message : 'Could not start research.'}
        </p>
      ) : null}
    </section>
  )
}
