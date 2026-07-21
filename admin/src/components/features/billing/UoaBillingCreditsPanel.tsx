import type {
  BillingCreditAmount,
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

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const isManagerCredits = (
  credits: BillingCreditsV1,
): credits is BillingCreditsManagerV1 =>
  credits.viewer.role === 'billing_manager'

const CreditCard = ({
  detail,
  label,
  value,
}: {
  detail: string
  label: string
  value: BillingCreditAmount
}) => (
  <div className="rounded-lg border border-[color:var(--sep)] p-3">
    <div className={sectionTitle}>{label}</div>
    <div className="mt-1 text-xl font-semibold text-[color:var(--tx)]">
      {value.display}
    </div>
    <div className="mt-1 text-xs text-[color:var(--tx2)]">{detail}</div>
  </div>
)

const ManagerServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsManagerV1
}) => (
  <div className="mt-5">
    <div className={sectionTitle}>Credits used by service</div>
    <div className="mt-2 grid gap-2">
      {credits.credit_summary.consumed_breakdown.length === 0 && (
        <div className="rounded-lg border border-[color:var(--sep)] p-3 text-sm text-[color:var(--tx2)]">
          No credits used in this period.
        </div>
      )}
      {credits.credit_summary.consumed_breakdown.map((item) => (
        <div
          className="rounded-lg border border-[color:var(--sep)] p-3"
          key={item.service.id}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold text-[color:var(--tx)]">
                {item.service.name}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {item.users.length} attributed user
                {item.users.length === 1 ? '' : 's'} ·{' '}
                {item.unattributed_credits_consumed.display} unattributed
              </div>
            </div>
            <div className="shrink-0 font-semibold text-[color:var(--tx)]">
              {item.credits_consumed.display}
            </div>
          </div>
          {item.users.length > 0 && (
            <div className="mt-3 grid gap-1 border-t border-[color:var(--sep)] pt-2 text-xs text-[color:var(--tx2)]">
              {item.users.map((user) => (
                <div
                  className="flex justify-between gap-3"
                  key={user.user_id}
                >
                  <span>{user.display_name}</span>
                  <span>{user.credits_consumed.display}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  </div>
)

const MemberServiceBreakdown = ({
  credits,
}: {
  credits: BillingCreditsMemberV1
}) => (
  <div className="mt-5">
    <div className={sectionTitle}>Credits used by service</div>
    <div className="mt-2 grid gap-2">
      {credits.credit_summary.consumed_breakdown.length === 0 && (
        <div className="rounded-lg border border-[color:var(--sep)] p-3 text-sm text-[color:var(--tx2)]">
          No credits used in this period.
        </div>
      )}
      {credits.credit_summary.consumed_breakdown.map((item) => (
        <div
          className="rounded-lg border border-[color:var(--sep)] p-3"
          key={item.service.id}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold text-[color:var(--tx)]">
                {item.service.name}
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {item.viewer_credits_consumed.display} yours ·{' '}
                {item.other_team_members_credits_consumed.display} other members
                {' '}· {item.unattributed_credits_consumed.display} unattributed
              </div>
            </div>
            <div className="shrink-0 font-semibold text-[color:var(--tx)]">
              {item.credits_consumed.display}
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
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
    <div className="mt-5 rounded-lg border border-[color:var(--sep)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className={sectionTitle}>Automatic top-up</div>
          <div className="mt-1 font-semibold text-[color:var(--tx)]">
            {automatic.display_status}
          </div>
          <p className="mt-1 text-xs text-[color:var(--tx2)]">
            {automatic.description}
          </p>
        </div>
        <div className="rounded-full border border-[color:var(--sep)] px-3 py-1 text-xs text-[color:var(--tx2)]">
          {automatic.state}
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-[color:var(--tx2)] sm:grid-cols-2 xl:grid-cols-4">
        <div>Threshold: {automatic.threshold?.display ?? 'Not set'}</div>
        <div>Monthly cap: {automatic.monthly_cap?.display ?? 'Not set'}</div>
        <div>Charged this month: {automatic.charged_this_month.display}</div>
        <div>
          Cap remaining: {automatic.remaining_monthly_cap?.display ?? 'Not set'}
        </div>
      </div>
    </div>
  )
}

const MemberAutomaticTopUp = ({
  credits,
}: {
  credits: BillingCreditsMemberV1
}) => (
  <div className="mt-5 rounded-lg border border-[color:var(--sep)] p-4">
    <div className={sectionTitle}>Automatic top-up</div>
    <div className="mt-2 text-sm font-semibold text-[color:var(--tx)]">
      Payment method status: {credits.automatic_top_up.payment_method.status}
    </div>
    <p className="mt-1 text-xs text-[color:var(--tx2)]">
      Detailed automatic top-up settings are managed by billing managers.
    </p>
  </div>
)

const AutomaticTopUp = ({ credits }: { credits: BillingCreditsV1 }) =>
  isManagerCredits(credits)
    ? <ManagerAutomaticTopUp credits={credits} />
    : <MemberAutomaticTopUp credits={credits} />

const RecentActivity = ({ credits }: { credits: BillingCreditsV1 }) => (
  <div className="mt-5">
    <div className={sectionTitle}>Recent credit activity</div>
    <div className="mt-2 grid gap-2">
      {credits.recent_entries.length === 0 && (
        <div className="rounded-lg border border-[color:var(--sep)] p-3 text-sm text-[color:var(--tx2)]">
          No recent credit activity.
        </div>
      )}
      {credits.recent_entries.map((entry) => (
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[color:var(--sep)] p-3"
          key={entry.id}
        >
          <div>
            <div className="font-semibold text-[color:var(--tx)]">
              {entry.label}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              {entry.detail}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx3)]">
              {new Date(entry.occurred_at).toLocaleString()}
            </div>
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold text-[color:var(--tx)]">
              {entry.direction === 'credit' ? '+' : '−'}{entry.credits.display}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx2)]">
              {entry.credit_balance_after.display} remaining
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
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
    <div className="mt-5 grid gap-4 xl:grid-cols-2">
      <div className="rounded-lg border border-[color:var(--sep)] p-4">
        <div className={sectionTitle}>{credits.funding_policy.title}</div>
        <p className="mt-1 text-xs text-[color:var(--tx2)]">
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
      </div>

      <div className="rounded-lg border border-[color:var(--sep)] p-4">
        <div className={sectionTitle}>Automatic top-up options</div>
        <div className="mt-3 grid gap-3">
          {credits.automatic_top_up.options.map((option) => {
            const optionId = option.setup_action.request.body.option_id
            return (
              <div
                className="rounded-md bg-[color:var(--overlay-weak)] p-3"
                key={optionId}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[color:var(--tx)]">
                      {option.label}
                    </div>
                    <div className="mt-1 text-xs text-[color:var(--tx2)]">
                      {option.description}
                    </div>
                  </div>
                  {option.selected && (
                    <span className="rounded-full border border-[color:var(--sep)] px-2 py-0.5 text-xs text-[color:var(--tx2)]">
                      Selected
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="admin-button admin-button-primary text-xs"
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
                    className="admin-button admin-button-secondary text-xs"
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
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {credits.automatic_top_up.disable_action && (
            <button
              className="admin-button admin-button-secondary text-xs"
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
              className="admin-button admin-button-secondary text-xs"
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
      </div>
    </div>
  )
}

export const UoaBillingCreditsPanel = () => {
  const credits = useUoaBillingCredits()
  const data = credits.data

  return (
    <section className="mb-8" data-testid="uoa-billing-credits">
      <div className={sectionTitle}>Team credits</div>
      <div className="mt-2 admin-card p-5">
        {credits.isLoading && (
          <div className="text-sm text-[color:var(--tx2)]">
            Loading team credits…
          </div>
        )}
        {credits.error && (
          <div className="rounded-md border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]">
            Credits are unavailable: {credits.error.message}
          </div>
        )}
        {data && (
          <>
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
              <div className="rounded-full border border-[color:var(--sep)] px-3 py-1 text-xs text-[color:var(--tx2)]">
                {data.viewer.role === 'billing_manager'
                  ? 'Full team detail'
                  : 'Your usage + team totals'}
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <CreditCard
                detail={data.pending_credits.description}
                label={data.pending_credits.label}
                value={data.credit_summary.pending_credits}
              />
              <CreditCard
                detail="Credits added during the current period"
                label="Added"
                value={data.credit_summary.credits_added}
              />
              <CreditCard
                detail="Credits used across connected services this period"
                label="Used"
                value={data.credit_summary.credits_consumed}
              />
            </div>

            <p className="mt-3 text-xs text-[color:var(--tx3)]">
              {data.conversion.description}
            </p>
            <ServiceBreakdown credits={data} />
            <RecentActivity credits={data} />
            <AutomaticTopUp credits={data} />
            <FundingActions credits={data} />
          </>
        )}
      </div>
    </section>
  )
}
