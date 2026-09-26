import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BudgetManager } from '../components/features/budgets/BudgetManager'
import {
  PricingManager,
  type PricingProfile,
} from '../components/features/budgets/PricingManager'
import { Notice } from '../components/primitives/Notice'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { OwnerGate } from '../components/shared/OwnerGate'
import { useIsOwner } from '../facades/auth/hooks'
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

export const OperationalTelemetryPage = () => {
  const { t, i18n } = useTranslation('operations')
  const locale = i18n.resolvedLanguage ?? 'en-GB'
  const formatCount = (count: number) => new Intl.NumberFormat(locale).format(count)
  const formatTokens = formatCount
  const formatCost = (amount: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${formatCount(bytes)} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    return `${new Intl.NumberFormat(locale, {
      maximumFractionDigits: value >= 10 ? 1 : 2,
    }).format(value)} ${units[unitIndex]}`
  }
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
  const outcomeNames: Record<string, string> = {
    pending: t('telemetry.outcome.pending'),
    running: t('telemetry.outcome.running'),
    waiting_approval: t('telemetry.outcome.waitingApproval'),
    waiting_input: t('telemetry.outcome.waitingInput'),
    completed: t('telemetry.outcome.completed'),
    failed: t('telemetry.outcome.failed'),
    cancelled: t('telemetry.outcome.cancelled'),
    unknown: t('telemetry.outcome.unknown'),
  }

  // `me` is null only when there is no session at all, which is never an
  // owner — OwnerGate refuses either way. This early return is what narrows
  // `me` for <BudgetManager> below.
  if (!me) {
    return (
      <section className="flex h-full min-h-0 flex-col">
        <ScreenHeader title={t('telemetry.title')} />
        <OwnerGate />
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it. */}
      <ScreenHeader title={t('telemetry.title')} />
      <OwnerGate>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 w-full max-w-xs">
            <select
              aria-label={t('telemetry.groupTokens')}
              className="admin-input"
              onChange={(event) => setGroupBy(event.target.value)}
              value={groupBy}
            >
              <option value="model">{t('telemetry.byModel')}</option>
              <option value="provider">{t('telemetry.byProvider')}</option>
              <option value="agentId">{t('telemetry.byAgent')}</option>
              <option value="actorId">{t('telemetry.byUser')}</option>
              <option value="channelId">{t('telemetry.byChannel')}</option>
              <option value="runId">{t('telemetry.byRun')}</option>
            </select>
          </div>
          <div className="admin-card mb-4 border border-[color:var(--sep)] p-4">
            <SectionLabel>{t('telemetry.internalOnly')}</SectionLabel>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {t('telemetry.internalDescription')}
            </p>
          </div>

          {costTrackingInactive && (
            <Notice className="mb-4" tone="warning">
              {t('telemetry.costInactive', {
                tokens: formatTokens(summary?.totalTokens ?? 0),
              })}
            </Notice>
          )}

          <QueryState
            errorLabel={t('telemetry.tokenLoadFailed')}
            loadingLabel={t('telemetry.tokenLoading')}
            query={summaryQuery}
          >
            {() => (
              <StatGrid className="lg:grid-cols-3">
                <StatTile
                  detail={t('telemetry.inputOutput', {
                    input: formatTokens(summary?.totalInputTokens ?? 0),
                    output: formatTokens(summary?.totalOutputTokens ?? 0),
                  })}
                  label={t('telemetry.totalTokens')}
                  value={formatTokens(summary?.totalTokens ?? 0)}
                />
                <StatTile
                  label={t('telemetry.estimatedCost')}
                  value={formatCost(summary?.totalEstimatedCost ?? 0, summary?.currency ?? 'USD')}
                />
                <StatTile
                  detail={t('telemetry.dayOf', {
                    day: estimate?.daysElapsed ?? 0, total: estimate?.daysInMonth ?? 30,
                  })}
                  label={t('telemetry.monthlyProjection')}
                  value={formatCost(estimate?.projectedMonthlyCost ?? 0, estimate?.currency ?? 'USD')}
                />
              </StatGrid>
            )}
          </QueryState>

          <BudgetManager organizationId={me.context.organizationId} />

          <PricingManager />

          {(summary?.breakdowns ?? []).length > 0 && (
            <div className="mt-4">
              <SectionLabel>{t('telemetry.breakdown')}</SectionLabel>
              <div className="mt-2 grid gap-2">
                {(summary?.breakdowns ?? []).map((breakdown) => (
                  <div
                    className="admin-card flex items-center justify-between p-3"
                    key={breakdown.key}
                  >
                    <div>
                      <div className="font-semibold text-[color:var(--tx)]">{breakdown.key}</div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {t('telemetry.inputOutput', {
                          input: formatTokens(breakdown.inputTokens),
                          output: formatTokens(breakdown.outputTokens),
                        })}
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
              <SectionLabel>{t('telemetry.spendByOutcome')}</SectionLabel>
              <div className="mt-2 grid gap-2">
                {(outcomeUsage?.outcomes ?? []).map((row) => (
                  <div
                    className="admin-card flex items-center justify-between p-3"
                    key={row.outcome}
                  >
                    <div>
                      <div className="font-semibold capitalize text-[color:var(--tx)]">
                        {outcomeNames[row.outcome] ?? t('telemetry.outcome.unknown')}
                      </div>
                      <div className="text-xs text-[color:var(--tx2)]">
                        {t('telemetry.runCount', { count: row.runCount,
                          formattedCount: formatCount(row.runCount) })}
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
            <SectionLabel>{t('telemetry.fileUsage')}</SectionLabel>
            <QueryState
              className="mt-2 py-6"
              errorLabel={t('telemetry.fileLoadFailed')}
              loadingLabel={t('telemetry.fileLoading')}
              query={fileUsageQuery}
            >
              {() => (
                <>
                  <StatGrid className="lg:grid-cols-4">
                    <StatTile
                      detail={t('telemetry.fileCount', { count: fileUsage?.currentAttachmentCount ?? 0,
                        formattedCount: formatCount(fileUsage?.currentAttachmentCount ?? 0) })}
                      label={t('telemetry.stored')}
                      value={formatBytes(fileUsage?.currentStoredBytes ?? 0)}
                    />
                    <StatTile label={t('telemetry.uploaded')} value={formatBytes(fileUsage?.uploadBytes ?? 0)} />
                    <StatTile label={t('telemetry.downloaded')} value={formatBytes(fileUsage?.downloadBytes ?? 0)} />
                    <StatTile
                      detail={t('telemetry.eventCount', { count: fileUsage?.totalTransferEvents ?? 0,
                        formattedCount: formatCount(fileUsage?.totalTransferEvents ?? 0) })}
                      label={t('telemetry.transfers')}
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
                              {t('telemetry.eventCount', { count: breakdown.events,
                                formattedCount: formatCount(breakdown.events) })}
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
            <SectionLabel>{t('telemetry.connectorUsage')}</SectionLabel>
            <div className="ml-auto w-44">
              <select
                aria-label={t('telemetry.groupConnectors')}
                className="admin-input"
                onChange={(event) => setConnectorGroupBy(event.target.value)}
                value={connectorGroupBy}
              >
                <option value="connectorType">{t('telemetry.byType')}</option>
                <option value="agentId">{t('telemetry.byAgent')}</option>
                <option value="channelId">{t('telemetry.byChannel')}</option>
                <option value="connectorId">{t('telemetry.byConnector')}</option>
                <option value="operation">{t('telemetry.byOperation')}</option>
              </select>
            </div>
          </div>
          <QueryState
            className="mt-2 py-6"
            errorLabel={t('telemetry.connectorLoadFailed')}
            loadingLabel={t('telemetry.connectorLoading')}
            query={connectorsQuery}
          >
            {() => (
              <>
                <StatGrid className="lg:grid-cols-2">
                  <StatTile label={t('telemetry.totalCalls')} value={formatCount(connectors?.totalCalls ?? 0)} />
                  <StatTile
                    label={t('telemetry.connectorCost')}
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
                            {t('telemetry.callCount', { count: breakdown.calls,
                              formattedCount: formatCount(breakdown.calls) })}
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
      </OwnerGate>
    </section>
  )
}
