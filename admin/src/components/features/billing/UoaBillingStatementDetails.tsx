import type {
  BillingConnectedServiceUsage,
  BillingPortfolioOrigin,
  BillingPortfolioUser,
  BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Row, RowList } from '../../shared/RowList'

const EmptyLine = ({ children }: { children: string }) => (
  <p className="text-sm text-[color:var(--tx2)]">{children}</p>
)

const PortfolioOrigin = ({
  origin,
}: {
  origin: BillingPortfolioOrigin
}) => (
  <div className="rounded-md bg-[color:var(--overlay-weak)] p-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tx)]">
          {origin.display_name}
        </div>
        <div className="mt-1 text-xs text-[color:var(--tx2)]">
          {origin.call_share.display}
        </div>
      </div>
      {origin.is_statement_product && (
        <Pill size="sm" tone="outline">This app</Pill>
      )}
    </div>
    <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
      {origin.usage.map((usage) => (
        <div key={usage.usage_unit}>{usage.display}</div>
      ))}
      {origin.provider_costs.map((cost) => (
        <div key={cost.currency}>{cost.display}</div>
      ))}
    </div>
  </div>
)

const PortfolioUser = ({ user }: { user: BillingPortfolioUser }) => (
  <div className="rounded-md bg-[color:var(--overlay-weak)] p-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tx)]">
          {user.display_name}
        </div>
        {user.email && (
          <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
            {user.email}
          </div>
        )}
      </div>
      <div className="text-right text-xs text-[color:var(--tx2)]">
        <div>{user.call_share.display}</div>
        <div className="mt-0.5">{user.calls} calls</div>
      </div>
    </div>
    <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
      {user.usage.map((usage) => (
        <div key={usage.usage_unit}>{usage.display}</div>
      ))}
      {user.provider_costs.map((cost) => (
        <div key={cost.currency}>{cost.display}</div>
      ))}
    </div>
  </div>
)

const ConnectedServiceUsage = ({
  service,
}: {
  service: BillingConnectedServiceUsage
}) => (
  <div className="py-4 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="text-base font-semibold text-[color:var(--tx)]">
          {service.title}
        </div>
        <div className="mt-1 max-w-3xl text-xs text-[color:var(--tx2)]">
          {service.description}
        </div>
      </div>
      <Pill size="sm" tone="outline">
        {service.access} · {service.direct_user_count} direct users
      </Pill>
    </div>

    <div className="mt-3 grid gap-2 text-xs text-[color:var(--tx2)] sm:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-md bg-[color:var(--overlay-weak)] p-3">
        {service.totals.calls} calls across this team
      </div>
      {service.totals.usage.map((usage) => (
        <div
          className="rounded-md bg-[color:var(--overlay-weak)] p-3"
          key={usage.usage_unit}
        >
          {usage.display}
        </div>
      ))}
      {service.totals.provider_costs.map((cost) => (
        <div
          className="rounded-md bg-[color:var(--overlay-weak)] p-3"
          key={cost.currency}
        >
          {cost.display}
        </div>
      ))}
    </div>

    <div className="mt-4">
      <SectionLabel size="sm">Where usage originated</SectionLabel>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {service.origins.map((origin) => (
          <PortfolioOrigin
            key={origin.product ?? origin.display_name}
            origin={origin}
          />
        ))}
      </div>
    </div>

    <div className="mt-4">
      <SectionLabel size="sm">Team members</SectionLabel>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {service.users.map((user) => (
          <PortfolioUser
            key={user.user_id ?? user.display_name}
            user={user}
          />
        ))}
      </div>
    </div>
  </div>
)

export const UoaBillingStatementDetails = ({
  statement,
}: {
  statement: BillingStatementV2
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
        <SectionLabel>Statement line items</SectionLabel>
        <div className="mt-2">
          {statement.commercial_lines.length === 0 ? (
            <EmptyLine>No subscription, usage, add-on, credit, or adjustment lines.</EmptyLine>
          ) : (
            <RowList label="Statement line items">
              {statement.commercial_lines.map((line) => (
                <Row
                  key={line.id}
                  subtitle={line.detail}
                  title={line.label}
                  trailing={
                    <span className="font-mono text-sm font-semibold text-[color:var(--tx)]">
                      {line.amount.display}
                    </span>
                  }
                />
              ))}
            </RowList>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SectionLabel>Access evidence</SectionLabel>
        <div className="mt-2">
          {statement.services.length === 0 ? (
            <EmptyLine>No connected service activity in this period.</EmptyLine>
          ) : (
            <RowList label="Access evidence">
              {statement.services.map((service) => (
                <Row
                  key={`${service.product}:${service.access}`}
                  subtitle={`${service.direct_user_count} direct team users`}
                  title={service.display_name}
                  trailing={<Pill size="sm" tone="outline">{service.access}</Pill>}
                />
              ))}
            </RowList>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SectionLabel>{statement.connected_service_usage.title}</SectionLabel>
        <div className="mt-1 max-w-4xl text-sm text-[color:var(--tx2)]">
          {statement.connected_service_usage.description}
        </div>
        <div className="mt-3">
          {statement.connected_service_usage.services.length === 0 ? (
            <EmptyLine>No connected service activity in this period.</EmptyLine>
          ) : (
            <div className="divide-y divide-[color:var(--sep)]">
              {statement.connected_service_usage.services.map((service) => (
                <ConnectedServiceUsage
                  key={service.billing_product}
                  service={service}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SectionLabel>Usage transparency</SectionLabel>
        <div className="mt-2">
          {statement.usage.lines.length === 0 ? (
            <EmptyLine>No metered usage in this period.</EmptyLine>
          ) : (
            <RowList label="Usage transparency">
              {statement.usage.lines.map((line) => (
                <Row
                  key={line.id}
                  subtitle={line.share.display}
                  title={serviceNames.get(line.service_id) ?? line.service_id}
                  trailing={
                    <div className="text-right">
                      <div className="font-mono text-sm font-semibold text-[color:var(--tx)]">
                        {line.rated_charge?.total.display ?? 'Not rated'}
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx2)]">
                        {line.calls} calls
                      </div>
                    </div>
                  }
                >
                  <div className="mt-2 grid gap-2 text-xs text-[color:var(--tx2)] sm:grid-cols-3">
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
                  <div className="mt-2 text-xs text-[color:var(--tx3)]">
                    Billed by {line.attribution.billing_product} · called through{' '}
                    {line.attribution.caller_product} · originated in{' '}
                    {line.attribution.origin_product}
                  </div>
                </Row>
              ))}
            </RowList>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SectionLabel>Per-user usage</SectionLabel>
        <div className="mt-2">
          {statement.usage.user_totals.length === 0 ? (
            <EmptyLine>No per-user metered usage in this period.</EmptyLine>
          ) : (
            <RowList label="Per-user usage">
              {statement.usage.user_totals.map((user) => (
                <Row
                  key={user.user_id}
                  subtitle={user.name ? user.email : undefined}
                  title={user.name ?? user.email}
                  trailing={<span className="text-xs text-[color:var(--tx2)]">{user.calls} calls</span>}
                >
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
                </Row>
              ))}
            </RowList>
          )}
        </div>
      </div>
    </>
  )
}
