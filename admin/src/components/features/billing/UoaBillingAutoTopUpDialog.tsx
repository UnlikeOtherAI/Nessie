import type { BillingCreditsManagerV1 } from '@unlikeotherai/billing-statement-protocol'

import {
  useUoaBillingAutoTopUpDisable,
  useUoaBillingAutoTopUpRecover,
  useUoaBillingAutoTopUpSelect,
  useUoaBillingAutoTopUpSetup,
} from '../../../facades/billing/hooks'
import { Pill } from '../../primitives/Pill'
import { Dialog } from '../../shared/Dialog'
import { KeyValueList } from '../../shared/KeyValueList'
import { Row, RowList } from '../../shared/RowList'

/**
 * The prototype's "Automatic top-up" modal. The real capability is
 * option-based (pick one of `automatic_top_up.options`, each with its own
 * baked-in threshold/refill/cap) rather than freeform threshold/cap fields,
 * so the modal presents those real option cards instead of fabricating text
 * inputs no mutation backs.
 */
export const UoaBillingAutoTopUpDialog = ({
  credits,
  onClose,
  open,
}: {
  credits: BillingCreditsManagerV1
  onClose: () => void
  open: boolean
}) => {
  const automatic = credits.automatic_top_up
  const setup = useUoaBillingAutoTopUpSetup()
  const select = useUoaBillingAutoTopUpSelect()
  const disable = useUoaBillingAutoTopUpDisable()
  const recover = useUoaBillingAutoTopUpRecover()

  const pending = setup.isPending || select.isPending || disable.isPending || recover.isPending
  const error = [setup.error, select.error, disable.error, recover.error]
    .find((value): value is Error => value instanceof Error)

  return (
    <Dialog
      description={automatic.description}
      dismissDisabled={pending}
      onClose={onClose}
      open={open}
      title="Automatic top-up"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-[color:var(--tx)]">
          {automatic.display_status}
        </div>
        <Pill tone="outline">{automatic.state}</Pill>
      </div>

      <KeyValueList
        className="mt-4"
        items={[
          { label: 'Threshold', value: automatic.threshold?.display ?? 'Not set' },
          { label: 'Monthly cap', value: automatic.monthly_cap?.display ?? 'Not set' },
          { label: 'Charged this month', value: automatic.charged_this_month.display },
          { label: 'Cap remaining', value: automatic.remaining_monthly_cap?.display ?? 'Not set' },
          { label: 'Payment method', value: automatic.payment_method.display },
        ]}
        layout="grid"
      />

      <div className="mt-5">
        <RowList label="Automatic top-up options">
          {automatic.options.map((option) => {
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
                    title={option.setup_action.disabled_reason ?? option.setup_action.description}
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
                    title={option.update_action.disabled_reason ?? option.update_action.description}
                    type="button"
                  >
                    {option.update_action.label}
                  </button>
                </div>
              </Row>
            )
          })}
        </RowList>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {automatic.disable_action && (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={!automatic.disable_action.enabled || pending}
            onClick={() => {
              disable.mutate()
            }}
            type="button"
          >
            {automatic.disable_action.label}
          </button>
        )}
        {automatic.recover_action && (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={!automatic.recover_action.enabled || pending}
            onClick={() => {
              recover.mutate(undefined, {
                onSuccess: (result) => {
                  window.location.assign(result.redirect_url)
                },
              })
            }}
            type="button"
          >
            {automatic.recover_action.label}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 text-xs text-[color:var(--danger-text)]">
          {error.message}
        </div>
      )}
    </Dialog>
  )
}
