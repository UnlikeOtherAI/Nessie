import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type {
  DeepWaterAgentAccessTarget,
  DeepWaterResearchDepth,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import {
  useDeepWaterAgentAccess,
  useDeepWaterResearchRuns,
  useLaunchDeepWaterResearch,
  useSetDeepWaterAgentAccess,
} from '../../../facades/integrations/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { DeepWaterRunHistory } from './DeepWaterRunHistory'

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

const boundedInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)))

const accessTargetLabel = (target: DeepWaterAgentAccessTarget): string =>
  target.agentKind === 'personal_assistant'
    ? 'Personal Assistant'
    : target.name

export const DeepWaterResearchPanel = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const launch = useLaunchDeepWaterResearch()
  const runsQuery = useDeepWaterResearchRuns()
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
  // Keep this readable after disable: server-side bundle provenance may still
  // need an explicit Revoke all even though the connector no longer launches.
  const accessQuery = useDeepWaterAgentAccess()
  const setAgentAccess = useSetDeepWaterAgentAccess()
  const personalAssistantReady =
    accessQuery.data?.personalAssistant?.enabled === true
  const ready = teamReady && connectorReady && personalAssistantReady
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

  const changeAccess = (
    target: DeepWaterAgentAccessTarget | null,
    enabled: boolean,
  ) => {
    if (target?.agentKind === 'shared') {
      setAgentAccess.mutate({
        agentId: target.agentId,
        enabled,
        target: 'agent',
      })
      return
    }
    setAgentAccess.mutate({
      enabled,
      target: 'personal_assistant',
    })
  }

  const accessTargets = [
    ...(accessQuery.data?.personalAssistant
      ? [accessQuery.data.personalAssistant]
      : []),
    ...(accessQuery.data?.sharedAgents ?? []),
  ]

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
            <span className={readinessClass(personalAssistantReady)}>
              {personalAssistantReady
                ? 'Personal Assistant granted'
                : 'Agent grant required'}
            </span>
          </div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2 text-right">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">
            Month-to-date activity
          </div>
          <div className="mt-1 text-sm font-semibold text-[var(--tx)]">
            {product.usageSummary.totalCalls} calls
          </div>
          <Link className="text-xs text-[var(--tx3)] underline" to="/tokens">
            Team credits and customer totals
          </Link>
        </div>
      </div>

      <DeepWaterRunHistory
        loading={runsQuery.isLoading}
        runs={runsQuery.data ?? []}
      />

      <section className="mt-4 rounded border border-[var(--sep)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-[var(--tx)]">
              Agent access
            </h4>
            <p className="mt-1 text-xs leading-5 text-[var(--tx3)]">
              All six Deep Water entries must be explicitly granted. Team scope
              and user tenancy are still checked on every call.
            </p>
            {!teamReady || !connectorReady ? (
              <p className="mt-1 text-xs leading-5 text-[var(--warning-text)]">
                Launch is unavailable, but retained agent grants remain visible
                here so they can be revoked safely.
              </p>
            ) : null}
          </div>
          {isOwner ? (
            <Link
              className="admin-button admin-button-secondary text-xs"
              to={`/agents/tools?deepWaterInstance=${product.mcpInstallation?.id ?? ''}`}
            >
              Manage individual tools
            </Link>
          ) : null}
        </div>

        {accessQuery.isLoading ? (
          <div className="mt-3 text-xs text-[var(--tx3)]">
            Checking agent access…
          </div>
        ) : accessQuery.isError ? (
          <div className="mt-3 text-xs text-[var(--danger-text)]">
            Could not check agent access.{' '}
            <button
              className="underline"
              onClick={() => void accessQuery.refetch()}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[var(--sep)] overflow-hidden rounded border border-[var(--sep)]">
            {accessTargets.map((target) => {
              const canRevoke = target.revocableGrantCount > 0
              const pending =
                setAgentAccess.isPending
                && (
                  setAgentAccess.variables?.target === 'personal_assistant'
                    ? target.agentKind === 'personal_assistant'
                    : setAgentAccess.variables?.agentId === target.agentId
                )
              return (
                <div
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  key={target.agentId}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--tx)]">
                      {accessTargetLabel(target)}
                    </div>
                    <div className="text-xs text-[var(--tx3)]">
                      {target.grantedToolCount}/{target.requiredToolCount} tools granted
                    </div>
                  </div>
                  {isOwner ? (
                    <button
                      className={[
                        'admin-button text-xs',
                        canRevoke
                          ? 'admin-button-secondary'
                          : 'admin-button-primary',
                      ].join(' ')}
                      disabled={
                        pending
                        || (!canRevoke
                          && accessQuery.data?.configured !== true)
                      }
                      onClick={() => changeAccess(target, !canRevoke)}
                      type="button"
                    >
                      {pending
                        ? 'Saving…'
                        : canRevoke
                          ? 'Revoke all'
                          : 'Grant all'}
                    </button>
                  ) : null}
                </div>
              )
            })}
            {!accessQuery.data?.personalAssistant && isOwner ? (
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-[var(--tx)]">
                    Personal Assistant
                  </div>
                  <div className="text-xs text-[var(--tx3)]">
                    Set up and grant all six tools
                  </div>
                </div>
                <button
                  className="admin-button admin-button-primary text-xs"
                  disabled={
                    setAgentAccess.isPending
                    || accessQuery.data?.configured !== true
                  }
                  onClick={() => changeAccess(null, true)}
                  type="button"
                >
                  {setAgentAccess.isPending ? 'Saving…' : 'Set up & grant'}
                </button>
              </div>
            ) : null}
          </div>
        )}
        {!isOwner && !personalAssistantReady ? (
          <p className="mt-2 text-xs text-[var(--tx3)]">
            An organization owner must grant Deep Water to the Personal Assistant.
          </p>
        ) : null}
        {setAgentAccess.isError ? (
          <p className="mt-2 text-xs text-[var(--danger-text)]">
            {setAgentAccess.error instanceof Error
              ? setAgentAccess.error.message
              : 'Could not change agent access.'}
          </p>
        ) : null}
      </section>

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
