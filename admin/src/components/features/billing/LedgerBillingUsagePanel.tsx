import { useQuery } from '@tanstack/react-query'
import type {
  LedgerBillingBreakdown,
  LedgerBillingGroupBy,
  NessieBillingUsageView,
} from '@nessie/schemas'
import { useState } from 'react'
import { useApiClient } from '../../../providers/ApiClientProvider'

type Breakdown = LedgerBillingBreakdown

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const currentUtcMonth = (): string => new Date().toISOString().slice(0, 7)

const formatInteger = (value: number): string =>
  new Intl.NumberFormat('en-US').format(value)

const formatDecimal = (value: string | null): string =>
  value === null
    ? 'Not recorded'
    : (() => {
        const [integer = '0', fraction] = value.split('.')
        const groupedInteger = new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 0,
        }).format(BigInt(integer))
        return fraction ? `${groupedInteger}.${fraction}` : groupedInteger
      })()

const sumExactDecimals = (values: string[]): string | null => {
  if (values.length === 0) return null
  const scale = Math.max(
    ...values.map((value) => value.split('.')[1]?.length ?? 0),
  )
  const sum = values.reduce((total, value) => {
    const [integer = '0', fraction = ''] = value.split('.')
    const negative = integer.startsWith('-')
    const unsignedInteger = negative ? integer.slice(1) : integer
    const scaled = BigInt(
      `${unsignedInteger}${fraction.padEnd(scale, '0')}`,
    )
    return total + (negative ? -scaled : scaled)
  }, 0n)
  const negative = sum < 0n
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  const integer = scale === 0 ? digits : digits.slice(0, -scale)
  const fraction = scale === 0
    ? ''
    : digits.slice(-scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

const formatMoney = (
  value: string | null,
  currency: string | null,
): string => {
  if (value === null || !currency) return 'Not recorded'
  return new Intl.NumberFormat('en-US', {
    currency,
    style: 'currency',
  }).format(Number(value))
}

const formatMinorMoney = (
  amountMinor: string | null,
  currency: string | null,
): string => {
  if (amountMinor === null || !currency) return 'No monthly fee'
  return new Intl.NumberFormat('en-US', {
    currency,
    style: 'currency',
  }).format(Number(amountMinor) / 100)
}

const titleCase = (value: string): string =>
  value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const totalRawUnits = (row: Breakdown): number =>
  row.rawProviderUsage.unitsIn
  + row.rawProviderUsage.unitsCachedIn
  + row.rawProviderUsage.unitsOut

const totalBillableUnits = (row: Breakdown): string | null => {
  const values = [
    row.customerBillableUnits.unitsIn,
    row.customerBillableUnits.unitsCachedIn,
    row.customerBillableUnits.unitsOut,
  ].filter((value): value is string => value !== null)
  return sumExactDecimals(values)
}

const scopeLabel = (
  data: NessieBillingUsageView,
  row: Breakdown,
): string => {
  if (data.groupBy === 'service') return titleCase(row.serviceId)
  if (!row.dimension) return 'Unknown'
  return data.display.dimensionLabels[row.dimension] ?? row.dimension
}

const productPath = (row: Breakdown): string => {
  const billing = row.billingProduct
    ? titleCase(row.billingProduct)
    : 'Unrated'
  if (!row.callerProduct || row.callerProduct === row.billingProduct) {
    return billing
  }
  return `${billing} · initiated by ${titleCase(row.callerProduct)}`
}

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
        No Ledger-rated usage was recorded for this team in the selected month.
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
            row.ratingStatus,
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
                {productPath(row)} · {formatInteger(row.calls)} calls · {titleCase(row.ratingStatus)}
              </div>
            </div>
            <div className="rounded-full border border-[color:var(--sep)] px-2 py-1 text-xs text-[color:var(--tx2)]">
              {titleCase(row.usageUnit)}
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AmountCell
              label="Raw provider usage"
              value={`${formatInteger(totalRawUnits(row))} ${row.usageUnit}`}
            />
            <AmountCell
              label="Billable usage"
              value={`${formatDecimal(totalBillableUnits(row))} · ${row.customerBillableUnitLabel}`}
            />
            <AmountCell
              label="Raw provider estimated"
              value={formatMoney(row.rawProviderEstimatedCost, row.rawProviderCurrency)}
            />
            <AmountCell
              label="Raw provider actual"
              value={formatMoney(row.rawProviderActualCost, row.rawProviderCurrency)}
            />
            <AmountCell
              label="Billing base"
              value={formatMoney(row.billingBaseAmount, row.billingBaseCurrency)}
            />
            <AmountCell
              label="Added value"
              value={formatMoney(row.billingMarkupAmount, row.billingBaseCurrency)}
            />
            <AmountCell
              label="Customer charge"
              value={formatMoney(row.customerCharge, row.customerChargeCurrency)}
            />
          </div>
        </article>
      ))}
    </div>
  )
}

const TariffSummary = ({ data }: { data: NessieBillingUsageView }) => {
  if (data.monthlyComponents.length === 0) {
    return (
      <div className="admin-card p-4 text-sm text-[color:var(--tx2)]">
        No tariff snapshot has been observed for this month yet.
      </div>
    )
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {data.monthlyComponents.map((component, index) => (
        <div
          className="admin-card p-4"
          key={[
            component.tariffId,
            component.assignmentId,
            component.callerProduct,
            index,
          ].join(':')}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-[color:var(--tx)]">
                {component.tariffKey
                  ? titleCase(component.tariffKey)
                  : 'Custom tariff'}
                {component.tariffVersion !== null
                  ? ` v${component.tariffVersion}`
                  : ''}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {component.assignmentScope
                  ? `${titleCase(component.assignmentScope)} assignment`
                  : 'Assignment unavailable'}
                {' · '}{formatInteger(component.observedCalls)} observed calls
              </div>
            </div>
            <div className="text-right text-sm font-semibold text-[color:var(--tx)]">
              {formatMinorMoney(component.amountMinor, component.currency)}
              <div className="text-[10px] font-normal uppercase tracking-wider text-[color:var(--tx3)]">
                monthly
              </div>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-[color:var(--tx3)]">Billable usage</dt>
              <dd className="font-medium text-[color:var(--tx)]">
                {component.usageMultiplierBps === null
                  ? 'Not configured'
                  : `${component.usageMultiplierBps / 100}% of raw units`}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--tx3)]">Added value</dt>
              <dd className="font-medium text-[color:var(--tx)]">
                {component.markupPercent === null
                  ? 'Not configured'
                  : `${component.markupPercent}%`}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--tx3)]">Collection</dt>
              <dd className="font-medium text-[color:var(--tx)]">
                {component.collectionMode
                  ? titleCase(component.collectionMode)
                  : 'Not configured'}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--tx3)]">Payments</dt>
              <dd className="font-medium text-[color:var(--tx)]">
                {component.paymentCollectionEnabled
                  ? 'Enabled'
                  : 'Disabled / custom'}
              </dd>
            </div>
          </dl>
        </div>
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
          <div className={sectionTitle}>Customer billing</div>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--tx)]">
            Ledger-rated usage
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
            Raw provider usage remains unchanged. Billable units show the tariff
            multiplier; charges show provider cost, billing base, and added value
            separately.
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
          Loading Ledger billing usage…
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
              <div className={sectionTitle}>Customer charges</div>
              {data.totals.customerCharges.length === 0
                ? (
                    <div className="mt-2 text-sm text-[color:var(--tx2)]">
                      No rated charge
                    </div>
                  )
                : data.totals.customerCharges.map((charge) => (
                    <div
                      className="mt-2 text-lg font-bold text-[color:var(--tx)]"
                      key={`${charge.billingProduct}:${charge.callerProduct}:${charge.currency}`}
                    >
                      {formatMoney(charge.amount, charge.currency)}
                      <span className="ml-2 text-xs font-normal text-[color:var(--tx2)]">
                        {titleCase(charge.billingProduct ?? 'unrated')}
                      </span>
                    </div>
                  ))}
            </div>
          </div>

          <div className="mt-5">
            <div className={sectionTitle}>Usage and charges</div>
            <div className="mt-2">
              <UsageBreakdown data={data} />
            </div>
          </div>

          <div className="mt-5">
            <div className={sectionTitle}>Tariff terms observed this month</div>
            <div className="mt-2">
              <TariffSummary data={data} />
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
