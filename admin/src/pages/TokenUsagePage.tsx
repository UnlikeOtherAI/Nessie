import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { BudgetManager } from '../components/features/budgets/BudgetManager'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

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

  if (!isOwner || !me) {
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

        <BudgetManager organizationId={me.context.organizationId} />

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
