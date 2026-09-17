import { useMemo, useState } from 'react'
import type {
  BillingConnectedServiceUsage,
  BillingPortfolioOrigin,
  BillingPortfolioUser,
  BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Row } from '../../shared/RowList'

// A flat divider-only list — deliberately not `RowList`, which draws its own
// bordered box outside a Card. The prototype has no boxes here, only thin
// row dividers.
const FlatList = ({ children }: { children: React.ReactNode }) => (
  <ul className="divide-y divide-[color:var(--sep)]">{children}</ul>
)

const EmptyLine = ({ children }: { children: string }) => (
  <p className="text-sm text-[color:var(--tx2)]">{children}</p>
)

const MetricTile = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md bg-[color:var(--overlay-weak)] p-3">
    <div className="text-sm font-semibold text-[color:var(--tx)]">{value}</div>
    <div className="text-xs text-[color:var(--tx2)]">{label}</div>
  </div>
)

const formatAmount = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

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

/** One row of the "Products" tab — a connected-service usage accordion entry. */
const ProductRow = ({
  isOpen,
  onToggle,
  service,
}: {
  isOpen: boolean
  onToggle: () => void
  service: BillingConnectedServiceUsage
}) => (
  <Row
    onClick={onToggle}
    subtitle={`${service.access} · ${service.direct_user_count} direct users`}
    title={service.display_name}
    trailing={(
      <>
        <span className="text-sm text-[color:var(--tx2)]">{service.totals.calls} calls</span>
        <span className="text-[color:var(--tx3)]">{isOpen ? '︿' : '﹀'}</span>
      </>
    )}
  >
    {isOpen && (
      <div className="mt-3 grid gap-4">
        <div className="flex flex-wrap gap-2">
          <MetricTile label="calls across this team" value={service.totals.calls} />
          {service.totals.usage.map((usage) => (
            <MetricTile key={usage.usage_unit} label={usage.usage_unit} value={usage.display} />
          ))}
          {service.totals.provider_costs.map((cost) => (
            <MetricTile key={cost.currency} label="raw provider cost" value={cost.display} />
          ))}
        </div>
        {service.origins.length > 0 && (
          <div>
            <SectionLabel size="sm">Where usage originated</SectionLabel>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {service.origins.map((origin) => (
                <PortfolioOrigin key={origin.product ?? origin.display_name} origin={origin} />
              ))}
            </div>
          </div>
        )}
        {service.users.length > 0 && (
          <div>
            <SectionLabel size="sm">Team members</SectionLabel>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {service.users.map((user) => (
                <PortfolioUser key={user.user_id ?? user.display_name} user={user} />
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-[color:var(--tx2)]">{service.description}</p>
      </div>
    )}
  </Row>
)

const ProductsTab = ({ statement }: { statement: BillingStatementV2 }) => {
  const [open, setOpen] = useState<string | null>(null)
  const services = statement.connected_service_usage.services
  if (services.length === 0) {
    return <EmptyLine>No connected service activity in this period.</EmptyLine>
  }
  return (
    <FlatList>
      {services.map((service) => (
        <ProductRow
          isOpen={open === service.billing_product}
          key={service.billing_product}
          onToggle={() => setOpen(open === service.billing_product ? null : service.billing_product)}
          service={service}
        />
      ))}
    </FlatList>
  )
}

/** One row of the "People" tab, with a per-service split derived from the
 * connected-service-usage portfolio (real fields, just recombined by user). */
const PersonRow = ({
  isOpen,
  onToggle,
  productsUsed,
  user,
}: {
  isOpen: boolean
  onToggle: () => void
  productsUsed: Array<{ name: string; value: string }>
  user: BillingStatementV2['usage']['user_totals'][number]
}) => (
  <Row
    onClick={onToggle}
    subtitle={user.name ? user.email : undefined}
    title={user.name ?? user.email}
    trailing={(
      <>
        <span className="text-sm text-[color:var(--tx2)]">{user.calls} calls</span>
        <span className="text-[color:var(--tx3)]">{isOpen ? '︿' : '﹀'}</span>
      </>
    )}
  >
    {isOpen && (
      <div className="mt-3 grid gap-4">
        <div className="flex flex-wrap gap-2">
          {user.usage.map((usage) => (
            <MetricTile
              key={usage.usage_unit}
              label={usage.usage_unit}
              value={`${usage.raw_units} raw / ${usage.billable_units} billed`}
            />
          ))}
          {user.costs.map((cost) => (
            <MetricTile
              key={cost.currency}
              label="total · markup"
              value={`${cost.usage_charge.display} · ${cost.markup.display}`}
            />
          ))}
        </div>
        {productsUsed.length > 0 && (
          <div>
            <SectionLabel size="sm">Products used</SectionLabel>
            <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
              {productsUsed.map((item) => (
                <div className="flex justify-between gap-3" key={item.name}>
                  <span>{item.name}</span>
                  <span>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )}
  </Row>
)

const PeopleTab = ({ statement }: { statement: BillingStatementV2 }) => {
  const [open, setOpen] = useState<string | null>(null)
  const users = statement.usage.user_totals
  const productsByUser = useMemo(() => {
    const map = new Map<string, Array<{ name: string; value: string }>>()
    for (const service of statement.connected_service_usage.services) {
      for (const user of service.users) {
        if (!user.user_id) continue
        const existing = map.get(user.user_id) ?? []
        existing.push({ name: service.display_name, value: user.call_share.display })
        map.set(user.user_id, existing)
      }
    }
    return map
  }, [statement.connected_service_usage.services])

  if (users.length === 0) {
    return <EmptyLine>No per-user metered usage in this period.</EmptyLine>
  }
  return (
    <FlatList>
      {users.map((user) => (
        <PersonRow
          isOpen={open === user.user_id}
          key={user.user_id}
          onToggle={() => setOpen(open === user.user_id ? null : user.user_id)}
          productsUsed={productsByUser.get(user.user_id) ?? []}
          user={user}
        />
      ))}
    </FlatList>
  )
}

/**
 * Nessie's billing/caller/origin product attribution — the real, closest
 * analog to the prototype's per-AI-provider (gemini/deepseek/serper)
 * breakdown. That literal per-vendor granularity has no field anywhere in
 * `billing-statement-protocol` and cannot be shown for real; this groups the
 * real `usage.lines` by `attribution.billing_product` instead.
 */
type ProviderGroup = {
  billedBy: string
  calls: number
  calledThrough: Array<{ callerProduct: string; lines: number }>
  charges: Map<string, { base: number; markup: number; total: number }>
  providerCosts: Map<string, number>
  units: Map<string, { billable: number; raw: number }>
}

const groupByBillingProduct = (
  statement: BillingStatementV2,
): ProviderGroup[] => {
  const groups = new Map<string, ProviderGroup>()
  for (const line of statement.usage.lines) {
    const key = line.attribution.billing_product
    const group: ProviderGroup = groups.get(key) ?? {
      billedBy: key,
      calledThrough: [],
      calls: 0,
      charges: new Map(),
      providerCosts: new Map(),
      units: new Map(),
    }
    group.calls += Number(line.calls)

    const callerProduct = line.attribution.caller_product
    const existingCaller = group.calledThrough.find((c) => c.callerProduct === callerProduct)
    if (existingCaller) existingCaller.lines += 1
    else group.calledThrough.push({ callerProduct, lines: 1 })

    const unit = group.units.get(line.usage_unit) ?? { billable: 0, raw: 0 }
    unit.raw += Number(line.raw_units.total)
    unit.billable += Number(line.billable_units.total)
    group.units.set(line.usage_unit, unit)

    if (line.provider_cost) {
      const currency = line.provider_cost.currency
      group.providerCosts.set(
        currency,
        (group.providerCosts.get(currency) ?? 0) + Number(line.provider_cost.amount),
      )
    }
    if (line.rated_charge) {
      const currency = line.rated_charge.total.currency
      const existing = group.charges.get(currency) ?? { base: 0, markup: 0, total: 0 }
      existing.base += Number(line.rated_charge.base.amount)
      existing.markup += Number(line.rated_charge.markup.amount)
      existing.total += Number(line.rated_charge.total.amount)
      group.charges.set(currency, existing)
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}

const ProviderRow = ({
  group,
  isOpen,
  onToggle,
  serviceName,
}: {
  group: ProviderGroup
  isOpen: boolean
  onToggle: () => void
  serviceName: string
}) => {
  const totalCurrency = [...group.charges.keys()][0]
  const totalCharge = totalCurrency ? group.charges.get(totalCurrency) : undefined
  return (
    <Row
      onClick={onToggle}
      subtitle={`billed by ${group.billedBy}`}
      title={serviceName}
      trailing={(
        <>
          <span className="text-sm text-[color:var(--tx2)]">
            {totalCharge && totalCurrency
              ? formatAmount(totalCharge.total, totalCurrency)
              : `${group.calls} calls`}
          </span>
          <span className="text-[color:var(--tx3)]">{isOpen ? '︿' : '﹀'}</span>
        </>
      )}
    >
      {isOpen && (
        <div className="mt-3 grid gap-4">
          <div className="flex flex-wrap gap-2">
            <MetricTile label="calls" value={String(group.calls)} />
            {[...group.units.entries()].map(([unit, totals]) => (
              <MetricTile
                key={unit}
                label={`raw / billed ${unit}`}
                value={`${totals.raw} / ${totals.billable}`}
              />
            ))}
            {[...group.charges.entries()].map(([currency, charge]) => (
              <MetricTile
                key={currency}
                label="base · markup"
                value={`${formatAmount(charge.base, currency)} · ${formatAmount(charge.markup, currency)}`}
              />
            ))}
          </div>
          {group.calledThrough.length > 0 && (
            <div>
              <SectionLabel size="sm">Called through</SectionLabel>
              <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
                {group.calledThrough.map((caller) => (
                  <div className="flex justify-between gap-3" key={caller.callerProduct}>
                    <span>{caller.callerProduct}</span>
                    <span>{caller.lines} of {group.calledThrough.reduce((n, c) => n + c.lines, 0)} lines</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Row>
  )
}

const ProvidersTab = ({ statement }: { statement: BillingStatementV2 }) => {
  const [open, setOpen] = useState<string | null>(null)
  const groups = useMemo(() => groupByBillingProduct(statement), [statement])
  const serviceNames = useMemo(
    () => new Map(statement.services.map((service) => [service.product, service.display_name])),
    [statement.services],
  )

  if (groups.length === 0) {
    return <EmptyLine>No metered usage in this period.</EmptyLine>
  }

  return (
    <>
      <p className="mb-3 text-xs text-[color:var(--tx3)]">
        Grouped by Nessie&apos;s own billing/caller/origin product attribution — the protocol
        does not track usage at the individual AI-provider level (e.g. a specific model vendor).
      </p>
      <FlatList>
        {groups.map((group) => (
          <ProviderRow
            group={group}
            isOpen={open === group.billedBy}
            key={group.billedBy}
            onToggle={() => setOpen(open === group.billedBy ? null : group.billedBy)}
            serviceName={serviceNames.get(group.billedBy) ?? group.billedBy}
          />
        ))}
      </FlatList>
    </>
  )
}

type UsageTab = 'people' | 'products' | 'providers'

const USAGE_TABS: readonly UsageTab[] = ['products', 'people', 'providers']

export const UoaBillingStatementDetails = ({
  statement,
}: {
  statement: BillingStatementV2
}) => {
  const [tab, setTab] = useTabParam('usage-tab', USAGE_TABS, 'products')

  return (
    <>
      <div className="mt-8">
        <h2 className="mb-1 text-[17px] font-semibold text-[color:var(--tx)]">Statement line items</h2>
        <div className="mt-2">
          {statement.commercial_lines.length === 0 ? (
            <EmptyLine>No subscription, usage, add-on, credit, or adjustment lines.</EmptyLine>
          ) : (
            <FlatList>
              {statement.commercial_lines.map((line) => (
                <Row
                  key={line.id}
                  subtitle={line.detail}
                  title={line.label}
                  trailing={
                    <span className="font-mono text-[color:var(--tx)]">
                      {line.amount.display}
                    </span>
                  }
                />
              ))}
            </FlatList>
          )}
        </div>
      </div>

      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">Usage</h2>
          <TabBar
            ariaLabel="Usage breakdown"
            idPrefix="uoa-billing-usage"
            items={[
              { label: 'Products', value: 'products' },
              { label: 'People', value: 'people' },
              { label: 'Providers', value: 'providers' },
            ]}
            onChange={setTab}
            role="tablist"
            size="sm"
            value={tab}
          />
        </div>
        <div className="mt-3">
          {tab === 'products' && <ProductsTab statement={statement} />}
          {tab === 'people' && <PeopleTab statement={statement} />}
          {tab === 'providers' && <ProvidersTab statement={statement} />}
        </div>
      </div>
    </>
  )
}
