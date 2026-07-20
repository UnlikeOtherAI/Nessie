import { useQuery } from '@tanstack/react-query'
import type {
  LedgerBillingBreakdown,
  LedgerBillingGroupBy,
  NessieBillingUsageView,
} from '@nessie/schemas'
import { useState } from 'react'
import { useApiClient } from '../../../providers/ApiClientProvider'

type Breakdown = LedgerBillingBreakdown
type ProductDimensions = Pick<
  Breakdown,
  'billingProduct' | 'callerProduct' | 'originProduct'
>

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const currentUtcMonth = (): string => new Date().toISOString().slice(0, 7)

const formatInteger = (value: number): string =>
  new Intl.NumberFormat('en-US').format(value)

const formatProviderCost = (
  value: string | null,
  currency: string | null,
): string => {
  if (value === null || !currency) return 'Not recorded'
  return `${currency.toUpperCase()} ${value}`
}

const titleCase = (value: string): string =>
  value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const scopeLabel = (
  data: NessieBillingUsageView,
  row: Breakdown,
): string => {
  if (data.groupBy === 'service') return titleCase(row.serviceId)
  if (!row.dimension) return 'Unknown'
  return data.display.dimensionLabels[row.dimension] ?? row.dimension
}

const productLabel = (value: string | null): string =>
  value ? titleCase(value) : 'Unattributed'

const productPath = (row: ProductDimensions): string =>
  [
    `Billed as ${productLabel(row.billingProduct)}`,
    `caller ${productLabel(row.callerProduct)}`,
    `origin ${productLabel(row.originProduct)}`,
  ].join(' · ')

const AmountCell = ({
  label,
  value,
}: {
  label: string
  value: string
}) => (
  <div>
    <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--tx3)]">
      {label}
    </div>
    <div className="mt-1 text-sm font-medium text-[color:var(--tx)]">
      {value}
    </div>
  </div>
)

const UsageBreakdown = ({
  data,
}: {
  data: NessieBillingUsageView
}) => {
  if (data.breakdown.length === 0) {
    return (
      <div className="admin-card p-5 text-sm text-[color:var(--tx2)]">
        No Ledger metering was recorded for this team in the selected month.
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {data.breakdown.map((row, index) => (
        <article
          className="admin-card p-4"
          key={[
            row.dimension,
            row.serviceId,
            row.billingProduct,
            row.callerProduct,
            row.originProduct,
            index,
          ].join(':')}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-[color:var(--tx)]">
                {scopeLabel(data, row)}
                {data.groupBy !== 'service' && (
                  <span className="font-normal text-[color:var(--tx2)]">
                    {' · '}{titleCase(row.serviceId)}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {productPath(row)} · {formatInteger(row.calls)} calls
              </div>
            </div>
            <div className="rounded-full border border-[color:var(--sep)] px-2 py-1 text-xs text-[color:var(--tx2)]">
              {titleCase(row.usageUnit)}
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <AmountCell
              label="Provider input"
              value={`${formatInteger(row.rawProviderUsage.unitsIn)} ${row.usageUnit}`}
            />
            <AmountCell
              label="Provider cached input"
              value={`${formatInteger(row.rawProviderUsage.unitsCachedIn)} ${row.usageUnit}`}
            />
            <AmountCell
              label="Provider output"
              value={`${formatInteger(row.rawProviderUsage.unitsOut)} ${row.usageUnit}`}
            />
            <AmountCell
              label="Provider estimated cost"
              value={formatProviderCost(
                row.rawProviderEstimatedCost,
                row.rawProviderCurrency,
              )}
            />
            <AmountCell
              label="Provider actual cost"
              value={formatProviderCost(
                row.rawProviderActualCost,
                row.rawProviderCurrency,
              )}
            />
          </div>
        </article>
      ))}
    </div>
  )
}

export const LedgerBillingUsagePanel = () => {
  const apiClient = useApiClient()
  const [month, setMonth] = useState(currentUtcMonth)
  const [groupBy, setGroupBy] = useState<LedgerBillingGroupBy>('service')
  const params = new URLSearchParams({ groupBy, month })
  const usage = useQuery<NessieBillingUsageView>({
    queryKey: ['ledger-billing-usage', month, groupBy],
    queryFn: () =>
      apiClient.get(`/api/ledger/billing/usage?${params.toString()}`),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  })
  const data = usage.data

  return (
    <section>
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className={sectionTitle}>Usage transparency</div>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--tx)]">
            Ledger metering
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
            Ledger records immutable provider and API usage with its service,
            caller, and origin. Commercial charges, subscriptions, and
            statements come only from the shared SSO.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            aria-label="Billing month"
            className="admin-input w-36"
            max={currentUtcMonth()}
            onChange={(event) => setMonth(event.target.value)}
            type="month"
            value={month}
          />
          <select
            aria-label="Group billed usage"
            className="admin-input w-36"
            onChange={(event) =>
              setGroupBy(event.target.value as LedgerBillingGroupBy)
            }
            value={groupBy}
          >
            <option value="service">By service</option>
            <option value="user">By user</option>
            <option value="team">By team</option>
          </select>
          <button
            className="admin-button admin-button-secondary"
            disabled={usage.isFetching}
            onClick={() => void usage.refetch()}
            type="button"
          >
            {usage.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {usage.error && (
        <div className="admin-card mt-4 border border-[var(--danger)] p-4 text-sm text-[color:var(--danger)]">
          {usage.error.message}
        </div>
      )}
      {usage.isLoading && (
        <div className="admin-card mt-4 p-5 text-sm text-[color:var(--tx2)]">
          Loading Ledger metering…
        </div>
      )}
      {data && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="admin-card p-4">
              <div className={sectionTitle}>Active scope</div>
              <div className="mt-2 font-semibold text-[color:var(--tx)]">
                {data.display.teamName}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {data.display.organizationName} · {data.scope.month}
              </div>
            </div>
            <div className="admin-card p-4">
              <div className={sectionTitle}>Metered calls</div>
              <div className="mt-2 text-2xl font-bold text-[color:var(--tx)]">
                {formatInteger(data.totals.calls)}
              </div>
            </div>
            <div className="admin-card p-4">
              <div className={sectionTitle}>Authority</div>
              <div className="mt-2 font-semibold text-[color:var(--tx)]">
                Metering only
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                Customer billing is calculated and displayed by UOA.
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className={sectionTitle}>Provider and API usage</div>
            <div className="mt-2">
              <UsageBreakdown data={data} />
            </div>
          </div>

          <div className="mt-3 text-xs text-[color:var(--tx3)]">
            Immutable Ledger snapshot {data.snapshot.cursor} captured{' '}
            {new Date(data.snapshot.capturedAt).toLocaleString()}.
          </div>
        </>
      )}
    </section>
  )
}
