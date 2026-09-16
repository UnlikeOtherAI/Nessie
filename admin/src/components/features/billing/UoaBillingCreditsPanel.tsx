import { useState } from 'react'
import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
  BillingCreditsV1,
} from '@unlikeotherai/billing-statement-protocol'

import { useUoaBillingCredits } from '../../../facades/billing/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Card } from '../../shared/Card'
import { Section } from '../../shared/PageBody'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { StatGrid, StatTile } from '../../shared/StatTile'
import { UoaBillingAutoTopUpDialog } from './UoaBillingAutoTopUpDialog'
import { UoaBillingBuyCreditsDialog } from './UoaBillingBuyCreditsDialog'

const isManagerCredits = (
  credits: BillingCreditsV1,
): credits is BillingCreditsManagerV1 =>
  credits.viewer.role === 'billing_manager'

const ManagerServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsManagerV1
}) => (
  <Section title="Credits used by service">
    {credits.credit_summary.consumed_breakdown.length === 0 ? (
      <p className="text-sm text-[color:var(--tx2)]">No credits used in this period.</p>
    ) : (
      <RowList label="Credits used by service">
        {credits.credit_summary.consumed_breakdown.map((item) => (
          <Row
            key={item.service.id}
            subtitle={`${item.users.length} attributed user${item.users.length === 1 ? '' : 's'} · ${item.unattributed_credits_consumed.display} unattributed`}
            title={item.service.name}
            trailing={<span className="font-semibold text-[color:var(--tx)]">{item.credits_consumed.display}</span>}
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
      </RowList>
    )}
  </Section>
)

const MemberServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsMemberV1
}) => (
  <Section title="Credits used by service">
    {credits.credit_summary.consumed_breakdown.length === 0 ? (
      <p className="text-sm text-[color:var(--tx2)]">No credits used in this period.</p>
    ) : (
      <RowList label="Credits used by service">
        {credits.credit_summary.consumed_breakdown.map((item) => (
          <Row
            key={item.service.id}
            subtitle={`${item.viewer_credits_consumed.display} yours · ${item.other_team_members_credits_consumed.display} other members · ${item.unattributed_credits_consumed.display} unattributed`}
            title={item.service.name}
            trailing={<span className="font-semibold text-[color:var(--tx)]">{item.credits_consumed.display}</span>}
          />
        ))}
      </RowList>
    )}
  </Section>
)

const ServiceBreakdown = ({ credits }: { credits: BillingCreditsV1 }) =>
  isManagerCredits(credits)
    ? <ManagerServiceBreakdown credits={credits} />
    : <MemberServiceBreakdown credits={credits} />

const ManagerAutomaticTopUp = ({
  credits,
  onOpen,
}: {
  credits: BillingCreditsManagerV1
  onOpen: () => void
}) => {
  const automatic = credits.automatic_top_up
  return (
    <Section title="Automatic top-up">
      <Row
        onClick={onOpen}
        subtitle={automatic.description}
        title={automatic.display_status}
        trailing={<Pill tone="outline">{automatic.state}</Pill>}
      />
    </Section>
  )
}

const MemberAutomaticTopUp = ({
  credits,
}: {
  credits: BillingCreditsMemberV1
}) => (
  <Section title="Automatic top-up">
    <div className="text-sm font-semibold text-[color:var(--tx)]">
      Payment method status: {credits.automatic_top_up.payment_method.status}
    </div>
    <p className="mt-1 text-xs text-[color:var(--tx2)]">
      Detailed automatic top-up settings are managed by billing managers.
    </p>
  </Section>
)

const AutomaticTopUp = ({
  credits,
  onOpenManager,
}: {
  credits: BillingCreditsV1
  onOpenManager: () => void
}) =>
  isManagerCredits(credits)
    ? <ManagerAutomaticTopUp credits={credits} onOpen={onOpenManager} />
    : <MemberAutomaticTopUp credits={credits} />

const RecentActivity = ({ credits }: { credits: BillingCreditsV1 }) => (
  <Section title="Recent credit activity">
    {credits.recent_entries.length === 0 ? (
      <p className="text-sm text-[color:var(--tx2)]">No recent credit activity.</p>
    ) : (
      <RowList label="Recent credit activity">
        {credits.recent_entries.map((entry) => (
          <Row
            key={entry.id}
            subtitle={`${entry.detail} · ${new Date(entry.occurred_at).toLocaleString()}`}
            title={entry.label}
            trailing={
              <div className="text-right text-sm">
                <div className="font-semibold text-[color:var(--tx)]">
                  {entry.direction === 'credit' ? '+' : '−'}{entry.credits.display}
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {entry.credit_balance_after.display} remaining
                </div>
              </div>
            }
          />
        ))}
      </RowList>
    )}
  </Section>
)

const BalanceActions = ({
  credits,
  onBuyCredits,
  onViewStatement,
}: {
  credits: BillingCreditsV1
  onBuyCredits: () => void
  onViewStatement?: () => void
}) => (
  <div className="flex flex-none gap-2">
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
    <section className="mb-8" data-testid="uoa-billing-credits">
      <SectionLabel>Team credits</SectionLabel>
      <Card className="mt-2" variant="section">
        <QueryState
          errorLabel="Credits are unavailable."
          loadingLabel="Loading team credits…"
          query={credits}
        >
          {() => data && (
            <div className="grid gap-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-3xl font-semibold text-[color:var(--tx)]" data-testid="remaining-credits">
                    {data.credit_balance.display}
                  </div>
                  <h2 className="mt-1 text-sm font-semibold text-[color:var(--tx)]">
                    {data.credit_balance.label}
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
                    {data.credit_balance.description}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-3">
                  <Pill tone="outline">
                    {data.viewer.role === 'billing_manager'
                      ? 'Full team detail'
                      : 'Your usage + team totals'}
                  </Pill>
                  <BalanceActions
                    credits={data}
                    onBuyCredits={() => setBuyCreditsOpen(true)}
                    onViewStatement={onViewStatement}
                  />
                </div>
              </div>

              <div>
                <StatGrid className="sm:grid-cols-3">
                  <StatTile
                    detail={data.pending_credits.description}
                    label={data.pending_credits.label}
                    value={data.credit_summary.pending_credits.display}
                  />
                  <StatTile
                    detail="Credits added during the current period"
                    label="Added"
                    value={data.credit_summary.credits_added.display}
                  />
                  <StatTile
                    detail="Credits used across connected services this period"
                    label="Used"
                    value={data.credit_summary.credits_consumed.display}
                  />
                </StatGrid>
                <p className="mt-3 text-xs text-[color:var(--tx3)]">
                  {data.conversion.description}
                </p>
              </div>

              <ServiceBreakdown credits={data} />
              <RecentActivity credits={data} />
              <AutomaticTopUp credits={data} onOpenManager={() => setAutoTopUpOpen(true)} />

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
      </Card>
    </section>
  )
}
