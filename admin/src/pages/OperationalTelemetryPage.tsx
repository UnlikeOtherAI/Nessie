import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { BudgetManager } from '../components/features/budgets/BudgetManager'
import {
  PricingManager,
  type PricingProfile,
} from '../components/features/budgets/PricingManager'
import { Notice } from '../components/primitives/Notice'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { OwnerGate, useIsOwner } from '../components/shared/OwnerGate'
import { QueryState } from '../components/shared/QueryState'
import { StatGrid, StatTile } from '../components/shared/StatTile'
import { opsTelemetryKeys } from '../lib/query-keys'
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

type OutcomeUsageSummary = {
  currency: string
  outcomes: Array<{
    outcome: string
    totalTokens: number
    estimatedCost: number
    eventCount: number
    runCount: number
  }>
  failedEstimatedCost: number
  failedTotalTokens: number
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

export const OperationalTelemetryPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const [groupBy, setGroupBy] = useState('model')
  const [connectorGroupBy, setConnectorGroupBy] = useState('connectorType')
  // Still the page's own flag: the six ledger reads below stay disabled for a
  // non-owner, exactly as before OwnerGate wrapped the render.
  const isOwner = useIsOwner()

  const summaryQuery = useQuery<TokenSummary>({
    queryKey: opsTelemetryKeys.tokenSummaryBy(groupBy),
    queryFn: () => apiClient.get(`/api/ledger/tokens/summary?groupBy=${groupBy}`),
    enabled: isOwner,
  })
  const { data: summary } = summaryQuery

  const connectorsQuery = useQuery<ConnectorSummary>({
    queryKey: opsTelemetryKeys.connectorSummary(connectorGroupBy),
    queryFn: () => apiClient.get(`/api/ledger/connectors/summary?groupBy=${connectorGroupBy}`),
    enabled: isOwner,
  })
  const { data: connectors } = connectorsQuery

  const fileUsageQuery = useQuery<FileUsageSummary>({
    queryKey: opsTelemetryKeys.fileUsageSummary,
    queryFn: () => apiClient.get('/api/ledger/files/summary'),
    enabled: isOwner,
  })
  const { data: fileUsage } = fileUsageQuery

  const { data: estimate } = useQuery<MonthlyEstimate>({
    queryKey: opsTelemetryKeys.tokenEstimate,
    queryFn: () => apiClient.get('/api/ledger/tokens/monthly-estimate'),
    enabled: isOwner,
  })

  const outcomeUsageQuery = useQuery<OutcomeUsageSummary>({
    queryKey: opsTelemetryKeys.tokenByOutcome,
    queryFn: () => apiClient.get('/api/ledger/tokens/by-outcome'),
    enabled: isOwner,
  })
  const { data: outcomeUsage } = outcomeUsageQuery

  const { data: pricingProfiles } = useQuery<PricingProfile[]>({
    queryKey: opsTelemetryKeys.pricingProfiles,
    queryFn: () => apiClient.get('/api/ledger/tokens/pricing'),
    enabled: isOwner,
  })

  const costTrackingInactive =
    (pricingProfiles?.length ?? 0) === 0 && (summary?.totalTokens ?? 0) > 0

  // `me` is null only when there is no session at all, which is never an
  // owner — OwnerGate refuses either way. This early return is what narrows
  // `me` for <BudgetManager> below.
  if (!me) {
    return <OwnerGate />
  }

  return (
    <OwnerGate>
      <section className="flex h-full min-h-0 flex-col">
        <AdminPageHeader title="Operational usage" />

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 w-full max-w-xs">
            <select
              aria-label="Group token telemetry"
              className="admin-input"
              onChange={(event) => setGroupBy(event.target.value)}
              value={groupBy}
            >
              <option value="model">By Model</option>
              <option value="provider">By Provider</option>
              <option value="agentId">By Agent</option>
              <option value="actorId">By User</option>
              <option value="channelId">By Channel</option>
              <option value="runId">By Run</option>
            </select>
          </div>
          <div className="admin-card mb-4 border border-[color:var(--sep)] p-4">
            <SectionLabel>Internal operations only</SectionLabel>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              These token, connector, file, budget, and model-pricing signals help
              owners operate Nessie. They are not customer credits, a tariff, or an
              invoice. Customer balances, statements, subscriptions, and charges
              are supplied by UOA on Credits &amp; billing.
            </p>
          </div>

          {costTrackingInactive && (
            <Notice className="mb-4" tone="warning">
              Cost tracking is inactive — {formatTokens(summary?.totalTokens ?? 0)} tokens recorded but
              no model pricing is configured, so every internal estimate shows $0. Add rates under
              <span className="font-semibold"> Model pricing</span> below to see operational estimates.
            </Notice>
          )}

          <QueryState
            errorLabel="Failed to load token usage."
            loadingLabel="Loading token usage…"
            query={summaryQuery}
          >
            {() => (
              <StatGrid className="lg:grid-cols-3">
                <StatTile
                  detail={`${formatTokens(summary?.totalInputTokens ?? 0)} in / ${formatTokens(summary?.totalOutputTokens ?? 0)} out`}
                  label="Total Tokens"
                  value={formatTokens(summary?.totalTokens ?? 0)}
                />
                <StatTile
                  label="Estimated Cost"
                  value={formatCost(summary?.totalEstimatedCost ?? 0, summary?.currency ?? 'USD')}
                />
                <StatTile
                  detail={`Day ${estimate?.daysElapsed ?? 0} of ${estimate?.daysInMonth ?? 30}`}
                  label="Monthly Projection"
                  value={formatCost(estimate?.projectedMonthlyCost ?? 0, estimate?.currency ?? 'USD')}
                />
              </StatGrid>
            )}
          </QueryState>

          <BudgetManager organizationId={me.context.organizationId} />

          <PricingManager />

          {(summary?.breakdowns ?? []).length > 0 && (
            <div className="mt-4">
              <SectionLabel>Breakdown</SectionLabel>
              <div className="mt-2 grid gap-2">
                {(summary?.breakdowns ?? []).map((breakdown) => (
                  <div
                    className="admin-card flex items-center justify-between p-3"
                    key={breakdown.key}
                  >
                    <div>
                      <div className="font-semibold text-[color:var(--tx)]">{breakdown.key}</div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {formatTokens(breakdown.inputTokens)} in /{' '}
                        {formatTokens(breakdown.outputTokens)} out
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-[color:var(--tx)]">
                        {formatTokens(breakdown.totalTokens)}
                      </div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {formatCost(breakdown.estimatedCost, summary?.currency ?? 'USD')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(outcomeUsage?.outcomes ?? []).length > 0 && (
            <div className="mt-6">
              <SectionLabel>Spend by Run Outcome</SectionLabel>
              <div className="mt-2 grid gap-2">
                {(outcomeUsage?.outcomes ?? []).map((row) => (
                  <div
                    className="admin-card flex items-center justify-between p-3"
                    key={row.outcome}
                  >
                    <div>
                      <div className="font-semibold capitalize text-[color:var(--tx)]">
                        {row.outcome}
                      </div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {formatCount(row.runCount)} {row.runCount === 1 ? 'run' : 'runs'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-[color:var(--tx)]">
                        {formatTokens(row.totalTokens)}
                      </div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {formatCost(row.estimatedCost, outcomeUsage?.currency ?? 'USD')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6">
            <SectionLabel>File Usage</SectionLabel>
            <QueryState
              className="mt-2 py-6"
              errorLabel="Failed to load file usage."
              loadingLabel="Loading file usage…"
              query={fileUsageQuery}
            >
              {() => (
                <>
                  <StatGrid className="lg:grid-cols-4">
                    <StatTile
                      detail={`${formatCount(fileUsage?.currentAttachmentCount ?? 0)} files`}
                      label="Stored"
                      value={formatBytes(fileUsage?.currentStoredBytes ?? 0)}
                    />
                    <StatTile label="Uploaded" value={formatBytes(fileUsage?.uploadBytes ?? 0)} />
                    <StatTile label="Downloaded" value={formatBytes(fileUsage?.downloadBytes ?? 0)} />
                    <StatTile
                      detail={`${formatCount(fileUsage?.totalTransferEvents ?? 0)} events`}
                      label="Transfers"
                      value={formatBytes(fileUsage?.totalTransferBytes ?? 0)}
                    />
                  </StatGrid>
                  {(fileUsage?.breakdowns ?? []).length > 0 && (
                    <div className="mt-2 grid gap-2">
                      {(fileUsage?.breakdowns ?? []).map((breakdown) => (
                        <div
                          className="admin-card flex items-center justify-between p-3"
                          key={breakdown.key}
                        >
                          <div className="font-semibold capitalize text-[color:var(--tx)]">
                            {breakdown.key}
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-sm text-[color:var(--tx)]">
                              {formatBytes(breakdown.bytes)}
                            </div>
                            <div className="text-xs text-[color:var(--tx2)]">
                              {formatCount(breakdown.events)} events
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </QueryState>
          </div>

          <div className="mt-6 flex items-center gap-4">
            <SectionLabel>Connector Usage</SectionLabel>
            <div className="ml-auto w-44">
              <select
                aria-label="Group connector telemetry"
                className="admin-input"
                onChange={(event) => setConnectorGroupBy(event.target.value)}
                value={connectorGroupBy}
              >
                <option value="connectorType">By Type</option>
                <option value="agentId">By Agent</option>
                <option value="channelId">By Channel</option>
                <option value="connectorId">By Connector</option>
                <option value="operation">By Operation</option>
              </select>
            </div>
          </div>
          <QueryState
            className="mt-2 py-6"
            errorLabel="Failed to load connector usage."
            loadingLabel="Loading connector usage…"
            query={connectorsQuery}
          >
            {() => (
              <>
                <StatGrid className="lg:grid-cols-2">
                  <StatTile label="Total Calls" value={formatCount(connectors?.totalCalls ?? 0)} />
                  <StatTile
                    label="Connector Cost"
                    value={formatCost(connectors?.totalCost ?? 0, connectors?.currency ?? 'USD')}
                  />
                </StatGrid>
                {(connectors?.breakdowns ?? []).length > 0 && (
                  <div className="mt-2 grid gap-2">
                    {(connectors?.breakdowns ?? []).map((breakdown) => (
                      <div
                        className="admin-card flex items-center justify-between p-3"
                        key={breakdown.key}
                      >
                        <div className="font-semibold text-[color:var(--tx)]">{breakdown.key}</div>
                        <div className="text-right">
                          <div className="font-mono text-sm text-[color:var(--tx)]">
                            {formatCount(breakdown.calls)} calls
                          </div>
                          <div className="text-xs text-[color:var(--tx2)]">
                            {formatCost(breakdown.cost, connectors?.currency ?? 'USD')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </QueryState>
        </div>
      </section>
    </OwnerGate>
  )
}
