import { Link } from 'react-router-dom'
import type { IntegratedProductResponse } from '../../../lib/api-client'

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
})

const formatCount = (value: number): string => numberFormatter.format(value)

const formatCost = (value: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, {
      currency,
      style: 'currency',
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

const formatDate = (value: string | null): string => {
  if (!value) return 'No calls this month'
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(value))
}

const operationLabel = (value: string | null): string =>
  value ? value.replace(/[-_]/g, ' ') : 'None yet'

const summaryBadgeLabel = (product: IntegratedProductResponse): string =>
  product.usageSummary.totalCalls > 0
    ? `${formatCount(product.usageSummary.totalCalls)} calls MTD`
    : 'No calls MTD'

export const productUsageBadgeLabel = summaryBadgeLabel

export const ProductOperationsSection = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const summary = product.usageSummary

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Operations</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            Product usage recorded through the connector ledger for the current month.
          </p>
        </div>
        <Link className="admin-button admin-button-secondary text-xs" to="/tokens">
          Usage ledger
        </Link>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Calls</div>
          <div className="mt-1 text-sm text-[var(--tx)]">{formatCount(summary.totalCalls)}</div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Units</div>
          <div className="mt-1 text-sm text-[var(--tx)]">{formatCount(summary.totalUnits)}</div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Spend</div>
          <div className="mt-1 text-sm text-[var(--tx)]">
            {formatCost(summary.totalCost, summary.currency)}
          </div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Last used</div>
          <div className="mt-1 text-sm text-[var(--tx)]">{formatDate(summary.lastUsedAt)}</div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Failures</div>
          <div className="mt-1 text-sm text-[var(--tx)]">{formatCount(summary.failureCount)}</div>
        </div>
      </div>

      <p className="mt-2 text-xs text-[var(--tx3)]">
        Last operation: {operationLabel(summary.lastOperation)}
      </p>
    </section>
  )
}
