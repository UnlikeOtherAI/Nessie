import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
  BillingCreditsV1,
} from '@unlikeotherai/billing-statement-protocol'

import {
  useUoaBillingAutoTopUpDisable,
  useUoaBillingAutoTopUpRecover,
  useUoaBillingAutoTopUpSelect,
  useUoaBillingAutoTopUpSetup,
  useUoaBillingCredits,
  useUoaBillingCreditTopUp,
} from '../../../facades/billing/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Card } from '../../shared/Card'
import { KeyValueList } from '../../shared/KeyValueList'
import { Section } from '../../shared/PageBody'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { StatGrid, StatTile } from '../../shared/StatTile'

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
}: {
  credits: BillingCreditsManagerV1
}) => {
  const automatic = credits.automatic_top_up
  return (
    <Section title="Automatic top-up">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-[color:var(--tx)]">
            {automatic.display_status}
          </div>
          <p className="mt-1 text-xs text-[color:var(--tx2)]">
            {automatic.description}
          </p>
        </div>
        <Pill tone="outline">{automatic.state}</Pill>
      </div>
      <KeyValueList
        className="mt-3"
        items={[
          { label: 'Threshold', value: automatic.threshold?.display ?? 'Not set' },
          { label: 'Monthly cap', value: automatic.monthly_cap?.display ?? 'Not set' },
          { label: 'Charged this month', value: automatic.charged_this_month.display },
          { label: 'Cap remaining', value: automatic.remaining_monthly_cap?.display ?? 'Not set' },
        ]}
        layout="grid"
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

const AutomaticTopUp = ({ credits }: { credits: BillingCreditsV1 }) =>
  isManagerCredits(credits)
    ? <ManagerAutomaticTopUp credits={credits} />
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

const FundingActions = ({ credits }: { credits: BillingCreditsV1 }) => {
  const topUp = useUoaBillingCreditTopUp()
  const setup = useUoaBillingAutoTopUpSetup()
  const select = useUoaBillingAutoTopUpSelect()
  const disable = useUoaBillingAutoTopUpDisable()
  const recover = useUoaBillingAutoTopUpRecover()
  if (!isManagerCredits(credits)) return null

  const pending = topUp.isPending
    || setup.isPending
    || select.isPending
    || disable.isPending
    || recover.isPending
  const error = [topUp.error, setup.error, select.error, disable.error, recover.error]
    .find((value): value is Error => value instanceof Error)

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title={credits.funding_policy.title}>
        <p className="text-xs text-[color:var(--tx2)]">
          {credits.funding_policy.description}
        </p>
        <div className="mt-3 grid gap-2">
          {credits.funding_policy.offers.map((offer) => (
            <button
              className="admin-button admin-button-primary"
              disabled={!offer.action.enabled || pending}
              key={offer.id}
              onClick={() => {
                topUp.mutate(offer.id, {
                  onSuccess: (result) => {
                    window.location.assign(result.redirect_url)
                  },
                })
              }}
              title={offer.action.disabled_reason ?? offer.action.description}
              type="button"
            >
              <span>{offer.action.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Automatic top-up options">
        <RowList label="Automatic top-up options">
          {credits.automatic_top_up.options.map((option) => {
            const optionId = option.setup_action.request.body.option_id
            return (
              <Row
                key={optionId}
                subtitle={option.description}
                title={option.label}
                trailing={option.selected ? <Pill tone="outline">Selected</Pill> : undefined}
              >
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="admin-button admin-button-primary admin-button-compact"
                    disabled={!option.setup_action.enabled || pending}
                    onClick={() => {
                      setup.mutate(optionId, {
                        onSuccess: (result) => {
                          window.location.assign(result.redirect_url)
                        },
                      })
                    }}
                    title={option.setup_action.disabled_reason
                      ?? option.setup_action.description}
                    type="button"
                  >
                    {option.setup_action.label}
                  </button>
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    disabled={!option.update_action.enabled || pending}
                    onClick={() => {
                      select.mutate(optionId)
                    }}
                    title={option.update_action.disabled_reason
                      ?? option.update_action.description}
                    type="button"
                  >
                    {option.update_action.label}
                  </button>
                </div>
              </Row>
            )
          })}
        </RowList>
        <div className="mt-3 flex flex-wrap gap-2">
          {credits.automatic_top_up.disable_action && (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={!credits.automatic_top_up.disable_action.enabled || pending}
              onClick={() => {
                disable.mutate()
              }}
              type="button"
            >
              {credits.automatic_top_up.disable_action.label}
            </button>
          )}
          {credits.automatic_top_up.recover_action && (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={!credits.automatic_top_up.recover_action.enabled || pending}
              onClick={() => {
                recover.mutate(undefined, {
                  onSuccess: (result) => {
                    window.location.assign(result.redirect_url)
                  },
                })
              }}
              type="button"
            >
              {credits.automatic_top_up.recover_action.label}
            </button>
          )}
        </div>
        {error && (
          <div className="mt-3 text-xs text-[color:var(--danger-text)]">
            {error.message}
          </div>
        )}
      </Section>
    </div>
  )
}

export const UoaBillingCreditsPanel = () => {
  const credits = useUoaBillingCredits()
  const data = credits.data

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
                <Pill tone="outline">
                  {data.viewer.role === 'billing_manager'
                    ? 'Full team detail'
                    : 'Your usage + team totals'}
                </Pill>
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
              <AutomaticTopUp credits={data} />
              <FundingActions credits={data} />
            </div>
          )}
        </QueryState>
      </Card>
    </section>
  )
}
