import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { budgetKeys } from '../../../lib/query-keys'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useProjects, useTeams } from '../../../facades/projects/hooks'
import { Pill, type PillTone } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'

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
  storageLimitBytes: string | null
  storageUsedBytes: string
}

const BYTES_PER_GB = 1024 ** 3

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

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

const levelTone: Record<BudgetStatus['level'], PillTone> = {
  ok: 'success',
  warn: 'warning',
  over: 'danger',
}

export const BudgetManager = ({ organizationId }: { organizationId: string }) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const budgetsQuery = useQuery<BudgetStatus[]>({
    queryKey: budgetKeys.all,
    queryFn: () => apiClient.get('/api/ledger/budgets'),
  })
  const budgets = budgetsQuery.data ?? []
  const { data: projects = [] } = useProjects()
  const { data: teams = [] } = useTeams()
  const [pendingDelete, setPendingDelete] = useState<BudgetStatus | null>(null)

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
  const [storageCapGb, setStorageCapGb] = useState('')
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
    setStorageCapGb('')
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: budgetKeys.all })
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
    onSuccess: () => {
      setPendingDelete(null)
      invalidate()
    },
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
    const storageGb = parseLimit(storageCapGb, false)
    if (storageGb === 'invalid') {
      setFormError('Storage cap must be a non-negative number of GB — leave blank for no cap.')
      return
    }
    setFormError(null)
    save.mutate({
      scopeType,
      scopeId: resolvedScopeId,
      costLimitUsd: cost,
      tokenLimit: tokens,
      storageLimitBytes: storageGb === null ? null : Math.round(storageGb * BYTES_PER_GB),
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
    setStorageCapGb(
      b.storageLimitBytes ? String(Number(b.storageLimitBytes) / BYTES_PER_GB) : '',
    )
  }

  const scopeLabel = (b: BudgetStatus): string => {
    if (b.scopeType === 'organization') return 'Organization'
    if (b.scopeType === 'project') return projects.find((p) => p.id === b.scopeId)?.name ?? 'Project'
    return teams.find((t) => t.id === b.scopeId)?.name ?? 'Team'
  }

  return (
    <div className="admin-card mt-4 p-4">
      <SectionLabel>Budgets</SectionLabel>
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

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          Storage cap (GB)
          <input
            className="admin-input mt-1"
            inputMode="decimal"
            onChange={(e) => setStorageCapGb(e.target.value)}
            placeholder="No cap"
            value={storageCapGb}
          />
          <span className="mt-1 block text-[11px] text-[color:var(--tx3)]">
            Blocks uploads for this scope once exceeded (applies in any mode).
          </span>
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

      <SectionLabel className="mt-5">Configured budgets ({budgets.length})</SectionLabel>
      <div className="mt-2 grid gap-2">
        <QueryState
          emptyLabel="No budgets configured"
          errorLabel="Failed to load budgets."
          isEmpty={budgets.length === 0}
          loadingLabel="Loading budgets…"
          query={budgetsQuery}
        >
          {() => (
            <>
              {budgets.map((b) => (
                <div key={`${b.scopeType}:${b.scopeId}`} className="admin-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-[var(--tx)]">{scopeLabel(b)}</span>
                      <span className="ml-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                        {b.scopeType} · {b.mode} · {b.period}
                      </span>
                    </div>
                    <Pill
                      className="shrink-0"
                      size="sm"
                      tone={b.mode === 'unlimited' ? 'muted' : levelTone[b.level]}
                    >
                      {b.mode === 'unlimited'
                        ? 'unlimited'
                        : b.percentUsed != null
                          ? `${b.percentUsed}% used`
                          : 'no cap'}
                    </Pill>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {formatTokens(b.spentTokens)} tokens · {formatUsd(b.spentUsd)} this {b.period.replace('ly', '')}
                    {b.costLimitUsd != null && ` · cap ${formatUsd(b.costLimitUsd)}`}
                    {b.tokenLimit != null && ` · cap ${formatTokens(b.tokenLimit)} tok`}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {formatBytes(Number(b.storageUsedBytes))} stored
                    {b.storageLimitBytes != null
                      ? ` of ${formatBytes(Number(b.storageLimitBytes))} cap`
                      : ' · no storage cap'}
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
                      onClick={() => setPendingDelete(b)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </QueryState>
      </div>

      <ConfirmDialog
        body={pendingDelete ? `This removes the ${scopeLabel(pendingDelete)} budget. It can be re-created later.` : undefined}
        confirmLabel="Delete budget"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            remove.mutate({ scopeType: pendingDelete.scopeType, scopeId: pendingDelete.scopeId })
          }
        }}
        open={pendingDelete != null}
        pending={remove.isPending}
        title="Delete this budget?"
      />
    </div>
  )
}
