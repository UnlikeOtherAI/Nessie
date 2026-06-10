import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useProjects, useTeams } from '../../../facades/projects/hooks'

type BudgetMode = 'off' | 'warn' | 'enforce' | 'degrade' | 'unlimited'
type BudgetScopeType = 'organization' | 'project' | 'team'
type BudgetPeriod = 'weekly' | 'monthly' | 'yearly'

type BudgetStatus = {
  scopeType: BudgetScopeType
  scopeId: string
  mode: BudgetMode
  period: BudgetPeriod
  costLimitUsd: number | null
  tokenLimit: number | null
  spentUsd: number
  spentTokens: number
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  degradeModel: string | null
  degradeProvider: string | null
  level: 'ok' | 'warn' | 'over'
  percentUsed: number | null
  costTrackingActive: boolean
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const formatTokens = (count: number) => new Intl.NumberFormat('en-US').format(count)
const formatUsd = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)

const parseLimit = (raw: string, integer: boolean): number | null | 'invalid' => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return integer ? Math.round(value) : value
}

const levelTone: Record<BudgetStatus['level'], string> = {
  ok: 'bg-[var(--success-soft)] text-[var(--success-text)]',
  warn: 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  over: 'bg-[var(--danger-soft)] text-[var(--danger-text)]',
}

export const BudgetManager = ({ organizationId }: { organizationId: string }) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const { data: budgets = [] } = useQuery<BudgetStatus[]>({
    queryKey: ['budgets'],
    queryFn: () => apiClient.get('/api/ledger/budgets'),
  })
  const { data: projects = [] } = useProjects()
  const { data: teams = [] } = useTeams()

  const [scopeType, setScopeType] = useState<BudgetScopeType>('organization')
  const [scopeId, setScopeId] = useState('')
  const [mode, setMode] = useState<BudgetMode>('warn')
  const [period, setPeriod] = useState<BudgetPeriod>('monthly')
  const [costLimit, setCostLimit] = useState('')
  const [tokenLimit, setTokenLimit] = useState('')
  const [warnThreshold, setWarnThreshold] = useState('80')
  const [blockHumans, setBlockHumans] = useState(false)
  const [degradeModel, setDegradeModel] = useState('')
  const [degradeProvider, setDegradeProvider] = useState('openai')
  const [formError, setFormError] = useState<string | null>(null)

  const resetForm = () => {
    setScopeType('organization')
    setScopeId('')
    setMode('warn')
    setPeriod('monthly')
    setCostLimit('')
    setTokenLimit('')
    setWarnThreshold('80')
    setBlockHumans(false)
    setDegradeModel('')
    setDegradeProvider('openai')
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['budgets'] })
  }

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiClient.put('/api/ledger/budget', payload),
    onSuccess: () => {
      setFormError(null)
      resetForm()
      invalidate()
    },
    onError: (err) => setFormError((err as Error).message),
  })

  const remove = useMutation({
    mutationFn: (target: { scopeType: BudgetScopeType; scopeId: string }) =>
      apiClient.delete(`/api/ledger/budget?scopeType=${target.scopeType}&scopeId=${target.scopeId}`),
    onSuccess: invalidate,
  })

  const handleSave = () => {
    const resolvedScopeId = scopeType === 'organization' ? organizationId : scopeId
    if (scopeType !== 'organization' && !scopeId) {
      setFormError('Pick a project or team for this budget.')
      return
    }
    const cost = parseLimit(costLimit, false)
    const tokens = parseLimit(tokenLimit, true)
    if (cost === 'invalid' || tokens === 'invalid') {
      setFormError('Caps must be non-negative numbers — leave blank for no cap.')
      return
    }
    const threshold = Math.round(Number(warnThreshold))
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      setFormError('Warn threshold must be between 1 and 100.')
      return
    }
    if (mode === 'degrade' && degradeModel.trim() === '') {
      setFormError('Degrade mode needs a fallback model to route to.')
      return
    }
    setFormError(null)
    save.mutate({
      scopeType,
      scopeId: resolvedScopeId,
      costLimitUsd: cost,
      tokenLimit: tokens,
      mode,
      period,
      warnThresholdPercent: threshold,
      blockHumansWhenOver: blockHumans,
      degradeModel: mode === 'degrade' ? degradeModel.trim() : null,
      degradeProvider: mode === 'degrade' ? degradeProvider.trim() || 'openai' : null,
    })
  }

  const editBudget = (b: BudgetStatus) => {
    setScopeType(b.scopeType)
    setScopeId(b.scopeType === 'organization' ? '' : b.scopeId)
    setMode(b.mode)
    setPeriod(b.period)
    setCostLimit(b.costLimitUsd != null ? String(b.costLimitUsd) : '')
    setTokenLimit(b.tokenLimit != null ? String(b.tokenLimit) : '')
    setWarnThreshold(String(b.warnThresholdPercent))
    setBlockHumans(b.blockHumansWhenOver)
    setDegradeModel(b.degradeModel ?? '')
    setDegradeProvider(b.degradeProvider ?? 'openai')
  }

  const scopeLabel = (b: BudgetStatus): string => {
    if (b.scopeType === 'organization') return 'Organization'
    if (b.scopeType === 'project') return projects.find((p) => p.id === b.scopeId)?.name ?? 'Project'
    return teams.find((t) => t.id === b.scopeId)?.name ?? 'Team'
  }

  return (
    <div className="admin-card mt-4 p-4">
      <div className={sectionTitle}>Budgets</div>
      <p className="mt-1 text-xs text-[color:var(--tx2)]">
        Most-specific budget wins (team &rarr; project &rarr; organization). A scope set to
        Unlimited is exempt and stops inheriting a parent cap. Soft cap &mdash; in-flight runs can
        overshoot slightly.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          Scope
          <select
            className="admin-input mt-1"
            onChange={(e) => {
              setScopeType(e.target.value as BudgetScopeType)
              setScopeId('')
            }}
            value={scopeType}
          >
            <option value="organization">Organization</option>
            <option value="project">Project</option>
            <option value="team">Team</option>
          </select>
        </label>
        {scopeType !== 'organization' && (
          <label className="text-xs text-[color:var(--tx2)]">
            {scopeType === 'project' ? 'Project' : 'Team'}
            <select
              className="admin-input mt-1"
              onChange={(e) => setScopeId(e.target.value)}
              value={scopeId}
            >
              <option value="">Select&hellip;</option>
              {(scopeType === 'project' ? projects : teams).map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          Mode
          <select
            className="admin-input mt-1"
            onChange={(e) => setMode(e.target.value as BudgetMode)}
            value={mode}
          >
            <option value="off">Off — inherit parent</option>
            <option value="warn">Warn — track, never block</option>
            <option value="enforce">Enforce — throttle automations</option>
            <option value="degrade">Degrade — cheaper model over cap</option>
            <option value="unlimited">Unlimited — exempt, no cap</option>
          </select>
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Period
          <select
            className="admin-input mt-1"
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
            value={period}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
      </div>

      {(mode === 'warn' || mode === 'enforce' || mode === 'degrade') && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-[color:var(--tx2)]">
            Cost cap (USD)
            <input
              className="admin-input mt-1"
              inputMode="decimal"
              onChange={(e) => setCostLimit(e.target.value)}
              placeholder="No cap"
              value={costLimit}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            Token cap
            <input
              className="admin-input mt-1"
              inputMode="numeric"
              onChange={(e) => setTokenLimit(e.target.value)}
              placeholder="No cap"
              value={tokenLimit}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            Warn at (%)
            <input
              className="admin-input mt-1"
              inputMode="numeric"
              onChange={(e) => setWarnThreshold(e.target.value)}
              placeholder="80"
              value={warnThreshold}
            />
          </label>
        </div>
      )}

      {mode === 'enforce' && (
        <label className="mt-3 flex items-center gap-2 text-sm text-[color:var(--tx2)]">
          <input
            checked={blockHumans}
            onChange={(e) => setBlockHumans(e.target.checked)}
            type="checkbox"
          />
          Also block people&apos;s live requests (off by default — only automations are throttled)
        </label>
      )}

      {mode === 'degrade' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[color:var(--tx2)]">
            Fallback model (used once over cap)
            <input
              className="admin-input mt-1"
              onChange={(e) => setDegradeModel(e.target.value)}
              placeholder="e.g. gpt-5-mini"
              value={degradeModel}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            Fallback provider
            <input
              className="admin-input mt-1"
              onChange={(e) => setDegradeProvider(e.target.value)}
              placeholder="openai"
              value={degradeProvider}
            />
          </label>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="admin-button admin-button-secondary" onClick={resetForm} type="button">
          Clear
        </button>
        <button
          className="admin-button admin-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
          type="button"
        >
          Save budget
        </button>
      </div>
      {formError && <div className="mt-2 text-xs text-[var(--danger-text)]">{formError}</div>}

      <div className={`${sectionTitle} mt-5`}>Configured budgets ({budgets.length})</div>
      <div className="mt-2 grid gap-2">
        {budgets.map((b) => (
          <div key={`${b.scopeType}:${b.scopeId}`} className="admin-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-semibold text-[var(--tx)]">{scopeLabel(b)}</span>
                <span className="ml-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {b.scopeType} · {b.mode} · {b.period}
                </span>
              </div>
              <span
                className={[
                  'shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]',
                  b.mode === 'unlimited' ? 'bg-[var(--overlay)] text-[color:var(--tx3)]' : levelTone[b.level],
                ].join(' ')}
              >
                {b.mode === 'unlimited'
                  ? 'unlimited'
                  : b.percentUsed != null
                    ? `${b.percentUsed}% used`
                    : 'no cap'}
              </span>
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              {formatTokens(b.spentTokens)} tokens · {formatUsd(b.spentUsd)} this {b.period.replace('ly', '')}
              {b.costLimitUsd != null && ` · cap ${formatUsd(b.costLimitUsd)}`}
              {b.tokenLimit != null && ` · cap ${formatTokens(b.tokenLimit)} tok`}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                className="admin-button admin-button-secondary"
                onClick={() => editBudget(b)}
                type="button"
              >
                Edit
              </button>
              <button
                className="admin-button admin-button-secondary"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ scopeType: b.scopeType, scopeId: b.scopeId })}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {budgets.length === 0 && (
          <div className="py-6 text-center text-[color:var(--tx3)]">No budgets configured</div>
        )}
      </div>
    </div>
  )
}
