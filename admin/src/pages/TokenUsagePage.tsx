import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { UoaBillingStatementPanel } from '../components/features/billing/UoaBillingStatementPanel'
import { BudgetManager } from '../components/features/budgets/BudgetManager'
import {
  PricingManager,
  PRICING_PROFILES_KEY,
  type PricingProfile,
} from '../components/features/budgets/PricingManager'
import {
  getUoaBillingCheckoutReturnNotice,
  readUoaBillingCheckoutReturn,
} from '../facades/billing/checkout-return'
import { billingStatementKey } from '../facades/billing/hooks'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'
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

type ConnectorSummary = {
  totalCalls: number
  totalUnits: number
  totalCost: number
  currency: string
  breakdowns: Array<{
    key: string
    calls: number
    units: number
    cost: number
  }>
}

type FileUsageSummary = {
  currentStoredBytes: number
  currentAttachmentCount: number
  totalTransferBytes: number
  totalTransferEvents: number
  uploadBytes: number
  downloadBytes: number
  breakdowns: Array<{
    key: string
    bytes: number
    events: number
  }>
}

const formatCount = (count: number) => new Intl.NumberFormat('en-US').format(count)

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const formatCost = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)

const formatTokens = (count: number) =>
  new Intl.NumberFormat('en-US').format(count)

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${formatCount(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value >= 10 ? 1 : 2,
  }).format(value)} ${units[unitIndex]}`
}

export const TokenUsagePage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const location = useLocation()
  const queryClient = useQueryClient()
  const refreshedCheckoutLocation = useRef<string | null>(null)
  const [groupBy, setGroupBy] = useState('model')
  const [connectorGroupBy, setConnectorGroupBy] = useState('connectorType')
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const canReadBilling =
    isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const checkoutReturn = readUoaBillingCheckoutReturn(location.search)
  const checkoutNotice = checkoutReturn
    ? getUoaBillingCheckoutReturnNotice(checkoutReturn)
    : null

  useEffect(() => {
    if (
      !canReadBilling
      || !checkoutReturn
      || refreshedCheckoutLocation.current === location.key
    ) {
      return
    }
    refreshedCheckoutLocation.current = location.key
    void queryClient.refetchQueries({
      exact: true,
      queryKey: billingStatementKey,
      type: 'all',
    })
  }, [canReadBilling, checkoutReturn, location.key, queryClient])

  const { data: summary } = useQuery<TokenSummary>({
    queryKey: ['token-summary', groupBy],
    queryFn: () => apiClient.get(`/api/ledger/tokens/summary?groupBy=${groupBy}`),
    enabled: isOwner,
  })

  const { data: connectors } = useQuery<ConnectorSummary>({
    queryKey: ['connector-summary', connectorGroupBy],
    queryFn: () => apiClient.get(`/api/ledger/connectors/summary?groupBy=${connectorGroupBy}`),
    enabled: isOwner,
  })

  const { data: fileUsage } = useQuery<FileUsageSummary>({
    queryKey: ['file-usage-summary'],
    queryFn: () => apiClient.get('/api/ledger/files/summary'),
    enabled: isOwner,
  })

  const { data: estimate } = useQuery<MonthlyEstimate>({
    queryKey: ['token-estimate'],
    queryFn: () => apiClient.get('/api/ledger/tokens/monthly-estimate'),
    enabled: isOwner,
  })

  const { data: pricingProfiles } = useQuery<PricingProfile[]>({
    queryKey: PRICING_PROFILES_KEY,
    queryFn: () => apiClient.get('/api/ledger/tokens/pricing'),
    enabled: isOwner,
  })

  // Usage is captured, but cost stays $0 until model pricing exists.
  const costTrackingInactive =
    (pricingProfiles?.length ?? 0) === 0 && (summary?.totalTokens ?? 0) > 0

  if (!canReadBilling || !me) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner or admin access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>Usage &amp; Billing</div>
        {isOwner && (
          <select
            className="admin-input ml-auto w-36"
            onChange={(e) => setGroupBy(e.target.value)}
            value={groupBy}
          >
            <option value="model">By Model</option>
            <option value="provider">By Provider</option>
            <option value="agentId">By Agent</option>
            <option value="actorId">By User</option>
            <option value="channelId">By Channel</option>
            <option value="runId">By Run</option>
          </select>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {checkoutNotice && (
          <div
            className="admin-card mb-4 border border-[color:var(--sep)] p-4"
            data-testid="uoa-billing-checkout-return"
            role="status"
          >
            <div className="font-semibold text-[color:var(--tx)]">
              {checkoutNotice.title}
            </div>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {checkoutNotice.message}
            </p>
          </div>
        )}
        <UoaBillingStatementPanel />
        {isOwner && (
          <>
            <div className="my-8 border-t border-[color:var(--sep)] pt-6">
              <div className={sectionTitle}>Operational telemetry</div>
              <p className="mt-1 text-sm text-[color:var(--tx2)]">
                Nessie&apos;s internal token, connector, file, budget, and model
                pricing telemetry supports operations. It is not the customer
                invoice; canonical tariffs, statements, and charges come from
                UOA above. Deep Water commercial amounts are never ingested or
                included in these local operational totals.
              </p>
            </div>
        {costTrackingInactive && (
          <div className="admin-card mb-4 border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]">
            Cost tracking is inactive — {formatTokens(summary?.totalTokens ?? 0)} tokens recorded but
            no model pricing is configured, so every internal estimate shows $0. Add rates under
            <span className="font-semibold"> Model pricing</span> below to see operational estimates.
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="admin-card p-4">
            <div className={sectionTitle}>Total Tokens</div>
            <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
              {formatTokens(summary?.totalTokens ?? 0)}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              {formatTokens(summary?.totalInputTokens ?? 0)} in /{' '}
              {formatTokens(summary?.totalOutputTokens ?? 0)} out
            </div>
          </div>
          <div className="admin-card p-4">
            <div className={sectionTitle}>Estimated Cost</div>
            <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
              {formatCost(summary?.totalEstimatedCost ?? 0, summary?.currency ?? 'USD')}
            </div>
          </div>
          <div className="admin-card p-4">
            <div className={sectionTitle}>Monthly Projection</div>
            <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
              {formatCost(estimate?.projectedMonthlyCost ?? 0, estimate?.currency ?? 'USD')}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              Day {estimate?.daysElapsed ?? 0} of {estimate?.daysInMonth ?? 30}
            </div>
          </div>
        </div>

        <BudgetManager organizationId={me.context.organizationId} />

        <PricingManager />

        {(summary?.breakdowns ?? []).length > 0 && (
          <div className="mt-4">
            <div className={sectionTitle}>Breakdown</div>
            <div className="mt-2 grid gap-2">
              {(summary?.breakdowns ?? []).map((b) => (
                <div key={b.key} className="admin-card flex items-center justify-between p-3">
                  <div>
                    <div className="font-semibold text-[color:var(--tx)]">{b.key}</div>
                    <div className="text-xs text-[color:var(--tx2)]">
                      {formatTokens(b.inputTokens)} in / {formatTokens(b.outputTokens)} out
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-[color:var(--tx)]">
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

        <div className="mt-6">
          <div className={sectionTitle}>File Usage</div>
          <div className="mt-2 grid gap-4 lg:grid-cols-4">
            <div className="admin-card p-4">
              <div className={sectionTitle}>Stored</div>
              <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
                {formatBytes(fileUsage?.currentStoredBytes ?? 0)}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {formatCount(fileUsage?.currentAttachmentCount ?? 0)} files
              </div>
            </div>
            <div className="admin-card p-4">
              <div className={sectionTitle}>Uploaded</div>
              <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
                {formatBytes(fileUsage?.uploadBytes ?? 0)}
              </div>
            </div>
            <div className="admin-card p-4">
              <div className={sectionTitle}>Downloaded</div>
              <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
                {formatBytes(fileUsage?.downloadBytes ?? 0)}
              </div>
            </div>
            <div className="admin-card p-4">
              <div className={sectionTitle}>Transfers</div>
              <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
                {formatBytes(fileUsage?.totalTransferBytes ?? 0)}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {formatCount(fileUsage?.totalTransferEvents ?? 0)} events
              </div>
            </div>
          </div>
          {(fileUsage?.breakdowns ?? []).length > 0 && (
            <div className="mt-2 grid gap-2">
              {(fileUsage?.breakdowns ?? []).map((b) => (
                <div key={b.key} className="admin-card flex items-center justify-between p-3">
                  <div className="font-semibold capitalize text-[color:var(--tx)]">{b.key}</div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-[color:var(--tx)]">
                      {formatBytes(b.bytes)}
                    </div>
                    <div className="text-xs text-[color:var(--tx2)]">
                      {formatCount(b.events)} events
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-4">
          <div className={sectionTitle}>Connector Usage</div>
          <select
            className="admin-input ml-auto w-44"
            onChange={(e) => setConnectorGroupBy(e.target.value)}
            value={connectorGroupBy}
          >
            <option value="connectorType">By Type</option>
            <option value="agentId">By Agent</option>
            <option value="channelId">By Channel</option>
            <option value="connectorId">By Connector</option>
            <option value="operation">By Operation</option>
          </select>
        </div>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <div className="admin-card p-4">
            <div className={sectionTitle}>Total Calls</div>
            <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
              {formatCount(connectors?.totalCalls ?? 0)}
            </div>
          </div>
          <div className="admin-card p-4">
            <div className={sectionTitle}>Connector Cost</div>
            <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
              {formatCost(connectors?.totalCost ?? 0, connectors?.currency ?? 'USD')}
            </div>
          </div>
        </div>
        {(connectors?.breakdowns ?? []).length > 0 && (
          <div className="mt-2 grid gap-2">
            {(connectors?.breakdowns ?? []).map((b) => (
              <div key={b.key} className="admin-card flex items-center justify-between p-3">
                <div className="font-semibold text-[color:var(--tx)]">{b.key}</div>
                <div className="text-right">
                  <div className="font-mono text-sm text-[color:var(--tx)]">
                    {formatCount(b.calls)} calls
                  </div>
                  <div className="text-xs text-[color:var(--tx2)]">
                    {formatCost(b.cost, connectors?.currency ?? 'USD')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
          </>
        )}
      </div>
    </section>
  )
}
