import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type BudgetStatus = {
  enforced: boolean
  costLimitUsd: number | null
  spentUsd: number
  tokenLimit: number | null
  spentTokens: number
  allowed: boolean
  costTrackingActive: boolean
}

const parseLimit = (raw: string, integer: boolean): number | null | 'invalid' => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return integer ? Math.round(value) : value
}

type TokenSummary = {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalEstimatedCost: number
  totalProviderReportedCost: number
  currency: string
  breakdowns: Array<{
    key: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    estimatedCost: number
    providerReportedCost: number
  }>
}

type MonthlyEstimate = {
  currentMonthUsage: number
  currentMonthCost: number
  projectedMonthlyCost: number
  currency: string
  daysElapsed: number
  daysInMonth: number
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const formatCost = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)

const formatTokens = (count: number) =>
  new Intl.NumberFormat('en-US').format(count)

export const TokenUsagePage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const [groupBy, setGroupBy] = useState('model')
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const { data: summary } = useQuery<TokenSummary>({
    queryKey: ['token-summary', groupBy],
    queryFn: () => apiClient.get(`/api/ledger/tokens/summary?groupBy=${groupBy}`),
    enabled: isOwner,
  })

  const { data: estimate } = useQuery<MonthlyEstimate>({
    queryKey: ['token-estimate'],
    queryFn: () => apiClient.get('/api/ledger/tokens/monthly-estimate'),
    enabled: isOwner,
  })

  const queryClient = useQueryClient()
  const { data: budget } = useQuery<BudgetStatus>({
    queryKey: ['budget'],
    queryFn: () => apiClient.get('/api/ledger/budget'),
    enabled: isOwner,
  })

  const [enforced, setEnforced] = useState(false)
  const [costLimit, setCostLimit] = useState('')
  const [tokenLimit, setTokenLimit] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!budget) return
    setEnforced(budget.enforced)
    setCostLimit(budget.costLimitUsd != null ? String(budget.costLimitUsd) : '')
    setTokenLimit(budget.tokenLimit != null ? String(budget.tokenLimit) : '')
  }, [budget])

  const saveBudget = useMutation({
    mutationFn: (payload: {
      monthlyCostLimitUsd: number | null
      monthlyTokenLimit: number | null
      enforced: boolean
    }) => apiClient.put('/api/ledger/budget', payload),
    onSuccess: () => {
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['budget'] })
    },
    onError: (err) => setFormError((err as Error).message),
  })

  const handleSaveBudget = () => {
    const cost = parseLimit(costLimit, false)
    const tokens = parseLimit(tokenLimit, true)
    if (cost === 'invalid' || tokens === 'invalid') {
      setFormError('Caps must be non-negative numbers — leave a field blank for no cap.')
      return
    }
    setFormError(null)
    saveBudget.mutate({ monthlyCostLimitUsd: cost, monthlyTokenLimit: tokens, enforced })
  }

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>Token Usage</div>
        <select
          className="admin-input ml-auto w-36"
          onChange={(e) => setGroupBy(e.target.value)}
          value={groupBy}
        >
          <option value="model">By Model</option>
          <option value="provider">By Provider</option>
          <option value="agentId">By Agent</option>
          <option value="actorId">By User</option>
        </select>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="admin-card p-4">
            <div className={sectionTitle}>Total Tokens</div>
            <div className="mt-2 text-2xl font-bold text-white">
              {formatTokens(summary?.totalTokens ?? 0)}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              {formatTokens(summary?.totalInputTokens ?? 0)} in /{' '}
              {formatTokens(summary?.totalOutputTokens ?? 0)} out
            </div>
          </div>
          <div className="admin-card p-4">
            <div className={sectionTitle}>Estimated Cost</div>
            <div className="mt-2 text-2xl font-bold text-white">
              {formatCost(summary?.totalEstimatedCost ?? 0, summary?.currency ?? 'USD')}
            </div>
          </div>
          <div className="admin-card p-4">
            <div className={sectionTitle}>Monthly Projection</div>
            <div className="mt-2 text-2xl font-bold text-white">
              {formatCost(estimate?.projectedMonthlyCost ?? 0, estimate?.currency ?? 'USD')}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              Day {estimate?.daysElapsed ?? 0} of {estimate?.daysInMonth ?? 30}
            </div>
          </div>
        </div>

        <div className="admin-card mt-4 p-4">
          <div className="flex items-center justify-between">
            <div className={sectionTitle}>Monthly Budget</div>
            {budget && (
              <span
                className={[
                  'rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]',
                  !budget.enforced
                    ? 'bg-white/10 text-[color:var(--tx3)]'
                    : budget.allowed
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-red-500/15 text-red-300',
                ].join(' ')}
              >
                {!budget.enforced
                  ? 'not enforced'
                  : budget.allowed
                    ? 'within budget'
                    : 'over budget — blocking'}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[color:var(--tx2)]">
            This month: {formatTokens(budget?.spentTokens ?? 0)} tokens ·{' '}
            {formatCost(budget?.spentUsd ?? 0, 'USD')} spent. Soft monthly cap —
            in-flight runs can overshoot slightly before spend is recorded.
          </div>
          {budget && costLimit.trim() !== '' && !budget.costTrackingActive && (
            <div className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              USD cap inactive — no pricing profile is configured, so estimated cost
              stays $0. Only the token cap is enforced.
            </div>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-[color:var(--tx2)]">
              Cost cap (USD / month)
              <input
                className="admin-input mt-1"
                inputMode="decimal"
                onChange={(e) => setCostLimit(e.target.value)}
                placeholder="No cap"
                value={costLimit}
              />
            </label>
            <label className="text-xs text-[color:var(--tx2)]">
              Token cap (tokens / month)
              <input
                className="admin-input mt-1"
                inputMode="numeric"
                onChange={(e) => setTokenLimit(e.target.value)}
                placeholder="No cap"
                value={tokenLimit}
              />
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-[color:var(--tx2)]">
              <input
                checked={enforced}
                onChange={(e) => setEnforced(e.target.checked)}
                type="checkbox"
              />
              Enforce — block runs once the cap is reached
            </label>
            <button
              className="admin-button admin-button-primary"
              disabled={saveBudget.isPending}
              onClick={handleSaveBudget}
              type="button"
            >
              Save budget
            </button>
          </div>
          {formError && (
            <div className="mt-2 text-xs text-red-300">{formError}</div>
          )}
        </div>

        {(summary?.breakdowns ?? []).length > 0 && (
          <div className="mt-4">
            <div className={sectionTitle}>Breakdown</div>
            <div className="mt-2 grid gap-2">
              {(summary?.breakdowns ?? []).map((b) => (
                <div key={b.key} className="admin-card flex items-center justify-between p-3">
                  <div>
                    <div className="font-semibold text-white">{b.key}</div>
                    <div className="text-xs text-[color:var(--tx2)]">
                      {formatTokens(b.inputTokens)} in / {formatTokens(b.outputTokens)} out
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-white">
                      {formatTokens(b.totalTokens)}
                    </div>
                    <div className="text-xs text-[color:var(--tx2)]">
                      {formatCost(b.estimatedCost, summary?.currency ?? 'USD')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
