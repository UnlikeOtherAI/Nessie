import { useState } from 'react'
import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
  BillingCreditsV1,
} from '@unlikeotherai/billing-statement-protocol'

import { useUoaBillingCredits } from '../../../facades/billing/hooks'
import { Pill } from '../../primitives/Pill'
import { QueryState } from '../../shared/QueryState'
import { Row } from '../../shared/RowList'
import { UoaBillingAutoTopUpDialog } from './UoaBillingAutoTopUpDialog'
import { UoaBillingBuyCreditsDialog } from './UoaBillingBuyCreditsDialog'

const isManagerCredits = (
  credits: BillingCreditsV1,
): credits is BillingCreditsManagerV1 =>
  credits.viewer.role === 'billing_manager'

// A flat divider-only list — deliberately not `RowList`, which draws its own
// bordered box outside a Card. The prototype has no boxes here, only thin
// row dividers.
const FlatList = ({ children }: { children: React.ReactNode }) => (
  <ul className="divide-y divide-[color:var(--sep)]">{children}</ul>
)

const ManagerServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsManagerV1
}) => (
  <div>
    <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">Credits used by service</h2>
    {credits.credit_summary.consumed_breakdown.length === 0 ? (
      <p className="mt-3 text-sm text-[color:var(--tx2)]">No credits used in this period.</p>
    ) : (
      <FlatList>
        {credits.credit_summary.consumed_breakdown.map((item) => (
          <Row
            key={item.service.id}
            subtitle={`${item.users.length} attributed user${item.users.length === 1 ? '' : 's'} · ${item.unattributed_credits_consumed.display} unattributed`}
            title={item.service.name}
            trailing={<span className="text-[color:var(--tx)]">{item.credits_consumed.display}</span>}
          >
            {item.users.length > 0 && (
              <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx2)]">
                {item.users.map((user) => (
                  <div className="flex justify-between gap-3" key={user.user_id}>
                    <span>{user.display_name}</span>
                    <span>{user.credits_consumed.display}</span>
                  </div>
                ))}
              </div>
            )}
          </Row>
        ))}
      </FlatList>
    )}
  </div>
)

const MemberServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsMemberV1
}) => (
  <div>
    <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">Credits used by service</h2>
    {credits.credit_summary.consumed_breakdown.length === 0 ? (
      <p className="mt-3 text-sm text-[color:var(--tx2)]">No credits used in this period.</p>
    ) : (
      <FlatList>
        {credits.credit_summary.consumed_breakdown.map((item) => (
          <Row
            key={item.service.id}
            subtitle={`${item.viewer_credits_consumed.display} yours · ${item.other_team_members_credits_consumed.display} other members · ${item.unattributed_credits_consumed.display} unattributed`}
            title={item.service.name}
            trailing={<span className="text-[color:var(--tx)]">{item.credits_consumed.display}</span>}
          />
        ))}
      </FlatList>
    )}
  </div>
)

const ServiceBreakdown = ({ credits }: { credits: BillingCreditsV1 }) =>
  isManagerCredits(credits)
    ? <ManagerServiceBreakdown credits={credits} />
    : <MemberServiceBreakdown credits={credits} />

const RecentActivity = ({ credits }: { credits: BillingCreditsV1 }) => (
  <div>
    <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">Recent credit activity</h2>
    {credits.recent_entries.length === 0 ? (
      <p className="mt-3 text-sm text-[color:var(--tx2)]">No recent credit activity.</p>
    ) : (
      <FlatList>
        {credits.recent_entries.map((entry) => (
          <Row
            key={entry.id}
            subtitle={`${entry.detail} · ${new Date(entry.occurred_at).toLocaleString()}`}
            title={entry.label}
            trailing={
              <div className="text-right text-sm">
                <div className="text-[color:var(--tx)]">
                  {entry.direction === 'credit' ? '+' : '−'}{entry.credits.display}
                </div>
                <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
                  {entry.credit_balance_after.display} remaining
                </div>
              </div>
            }
          />
        ))}
      </FlatList>
    )}
  </div>
)

const AutoTopUpRow = ({
  credits,
  onOpen,
}: {
  credits: BillingCreditsV1
  onOpen: () => void
}) => {
  if (!isManagerCredits(credits)) {
    return (
      <div className="mt-5 border-y border-[color:var(--sep)] py-4">
        <div className="font-medium text-[color:var(--tx)]">Automatic top-up</div>
        <div className="mt-0.5 text-sm text-[color:var(--tx2)]">
          Payment method status: {credits.automatic_top_up.payment_method.status}
        </div>
        <p className="mt-1 text-xs text-[color:var(--tx2)]">
          Detailed automatic top-up settings are managed by billing managers.
        </p>
      </div>
    )
  }

  const automatic = credits.automatic_top_up
  return (
    <button
      className="mt-5 flex w-full items-center justify-between gap-4 border-y border-[color:var(--sep)] py-4 text-left"
      onClick={onOpen}
      type="button"
    >
      <div className="min-w-0">
        <div className="font-medium text-[color:var(--tx)]">{automatic.display_status}</div>
        <div className="mt-0.5 text-sm text-[color:var(--tx2)]">{automatic.description}</div>
      </div>
      <span className="flex-none text-[color:var(--tx3)]">›</span>
    </button>
  )
}

const BalanceActions = ({
  credits,
  onBuyCredits,
  onViewStatement,
}: {
  credits: BillingCreditsV1
  onBuyCredits: () => void
  onViewStatement?: () => void
}) => (
  <div className="flex flex-none gap-2.5">
    {onViewStatement && (
      <button
        className="admin-button admin-button-secondary"
        onClick={onViewStatement}
        type="button"
      >
        View statement
      </button>
    )}
    {isManagerCredits(credits) && credits.capabilities.can_top_up && (
      <button
        className="admin-button admin-button-primary"
        onClick={onBuyCredits}
        type="button"
      >
        Buy credits
      </button>
    )}
  </div>
)

export const UoaBillingCreditsPanel = ({
  onViewStatement,
}: {
  /** Omitted when the viewer's capability grant has no readable statement. */
  onViewStatement?: () => void
} = {}) => {
  const credits = useUoaBillingCredits()
  const data = credits.data
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false)
  const [autoTopUpOpen, setAutoTopUpOpen] = useState(false)

  return (
    <section data-testid="uoa-billing-credits">
      <QueryState
        errorLabel="Credits are unavailable."
        loadingLabel="Loading team credits…"
        query={credits}
      >
        {() => data && (
          <div className="grid gap-8">
            <div>
              <div className="mb-3.5 flex items-center gap-2.5">
                <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">Credits balance</h2>
                <Pill size="sm" tone="outline">
                  {data.viewer.role === 'billing_manager'
                    ? 'Full team detail'
                    : 'Your usage + team totals'}
                </Pill>
              </div>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div
                    className="text-[28px] font-semibold tracking-tight text-[color:var(--tx)]"
                    data-testid="remaining-credits"
                  >
                    {data.credit_balance.display}
                  </div>
                  <div className="mt-1 text-sm font-medium text-[color:var(--tx)]">
                    {data.credit_balance.label}
                  </div>
                  <p className="mt-1 max-w-2xl text-[color:var(--tx2)]">
                    {data.credit_balance.description}
                  </p>
                  <p className="mt-2 text-sm text-[color:var(--tx3)]">
                    {data.credit_summary.credits_added.display} added ·{' '}
                    {data.credit_summary.credits_consumed.display} used ·{' '}
                    {data.credit_summary.pending_credits.display} pending
                  </p>
                </div>
                <BalanceActions
                  credits={data}
                  onBuyCredits={() => setBuyCreditsOpen(true)}
                  onViewStatement={onViewStatement}
                />
              </div>
              <AutoTopUpRow credits={data} onOpen={() => setAutoTopUpOpen(true)} />
              <p className="mt-3 text-xs text-[color:var(--tx3)]">
                {data.conversion.description}
              </p>
            </div>

            <ServiceBreakdown credits={data} />
            <RecentActivity credits={data} />

            {isManagerCredits(data) && (
              <>
                <UoaBillingBuyCreditsDialog
                  credits={data}
                  onClose={() => setBuyCreditsOpen(false)}
                  open={buyCreditsOpen}
                />
                <UoaBillingAutoTopUpDialog
                  credits={data}
                  onClose={() => setAutoTopUpOpen(false)}
                  open={autoTopUpOpen}
                />
              </>
            )}
          </div>
        )}
      </QueryState>
    </section>
  )
}
