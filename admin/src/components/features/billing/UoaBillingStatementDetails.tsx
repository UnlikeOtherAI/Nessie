import type { UoaBillingStatementV1 } from '@nessie/schemas'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

const EmptyLine = ({ children }: { children: string }) => (
  <div className="rounded-lg bg-[color:var(--overlay-weak)] p-3 text-sm text-[color:var(--tx2)]">
    {children}
  </div>
)

export const UoaBillingStatementDetails = ({
  statement,
}: {
  statement: UoaBillingStatementV1
}) => {
  const serviceNames = new Map(
    statement.services.map((service) => [
      service.product,
      service.display_name,
    ]),
  )

  return (
    <>
      <div className="mt-6">
        <div className={sectionTitle}>Statement line items</div>
        <div className="mt-2 grid gap-2">
          {statement.commercial_lines.length === 0 && (
            <EmptyLine>No subscription, usage, add-on, credit, or adjustment lines.</EmptyLine>
          )}
          {statement.commercial_lines.map((line) => (
            <div
              className="flex items-start justify-between gap-4 rounded-lg border border-[color:var(--sep)] p-3"
              key={line.id}
            >
              <div>
                <div className="text-sm font-semibold text-[color:var(--tx)]">
                  {line.label}
                </div>
                <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
                  {line.detail}
                </div>
              </div>
              <div className="shrink-0 font-mono text-sm font-semibold text-[color:var(--tx)]">
                {line.amount.display}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <div className={sectionTitle}>Connected services</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {statement.services.length === 0 && (
            <EmptyLine>No connected service activity in this period.</EmptyLine>
          )}
          {statement.services.map((service) => (
            <div
              className="rounded-lg border border-[color:var(--sep)] p-3"
              key={`${service.product}:${service.access}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-[color:var(--tx)]">
                  {service.display_name}
                </div>
                <span className="rounded-full border border-[color:var(--sep)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--tx3)]">
                  {service.access}
                </span>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {service.direct_user_count} direct team users
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <div className={sectionTitle}>Usage transparency</div>
        <div className="mt-2 grid gap-2">
          {statement.usage.lines.length === 0 && (
            <EmptyLine>No metered usage in this period.</EmptyLine>
          )}
          {statement.usage.lines.map((line) => (
            <div
              className="rounded-lg border border-[color:var(--sep)] p-3"
              key={line.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--tx)]">
                    {serviceNames.get(line.service_id) ?? line.service_id}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {line.share.display}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold text-[color:var(--tx)]">
                    {line.rated_charge?.total.display ?? 'Not rated'}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {line.calls} calls
                  </div>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-[color:var(--tx2)] sm:grid-cols-3">
                <div>
                  Raw: {line.raw_units.total} {line.usage_unit}
                </div>
                <div>
                  Billed: {line.billable_units.total} {line.usage_unit}
                </div>
                <div>
                  Provider: {line.provider_cost?.display ?? 'Unavailable'}
                </div>
              </div>
              {line.rated_charge && (
                <div className="mt-2 text-xs text-[color:var(--tx2)]">
                  Base {line.rated_charge.base.display} · Markup{' '}
                  {line.rated_charge.markup.display}
                </div>
              )}
              <div className="mt-2 text-[10px] text-[color:var(--tx3)]">
                Billed by {line.attribution.billing_product} · called through{' '}
                {line.attribution.caller_product} · originated in{' '}
                {line.attribution.origin_product}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <div className={sectionTitle}>Per-user usage</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {statement.usage.user_totals.length === 0 && (
            <EmptyLine>No per-user metered usage in this period.</EmptyLine>
          )}
          {statement.usage.user_totals.map((user) => (
            <div
              className="rounded-lg border border-[color:var(--sep)] p-3"
              key={user.user_id}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--tx)]">
                    {user.name ?? user.email}
                  </div>
                  {user.name && (
                    <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
                      {user.email}
                    </div>
                  )}
                </div>
                <div className="text-xs text-[color:var(--tx2)]">
                  {user.calls} calls
                </div>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
                {user.usage.map((usage) => (
                  <div key={usage.usage_unit}>
                    {usage.raw_units} raw / {usage.billable_units} billed{' '}
                    {usage.usage_unit}
                  </div>
                ))}
                {user.costs.map((cost) => (
                  <div key={cost.currency}>
                    {cost.usage_charge.display} total ·{' '}
                    {cost.markup.display} markup
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
