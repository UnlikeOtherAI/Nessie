import { useState } from 'react'
import {
  useDisconnectModelSubscription,
  useLinkModelSubscription,
  useModelSubscriptionProviders,
  useModelSubscriptions,
  type ModelSubscription,
  type ModelSubscriptionProviderOption,
} from '../../../facades/subscriptions/hooks'
import { DeviceLinkDialog } from './DeviceLinkDialog'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Dialog } from '../../../components/shared/Dialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import {
  fieldErrorAria,
  renderFieldError,
} from '../../../components/shared/FormFieldError'
import { QueryState } from '../../../components/shared/QueryState'

/**
 * "Personal model subscriptions" — a person links their own consumer AI plan
 * (Kimi, GLM today) so the agents they own run on it instead of the
 * organisation's credits.
 *
 * Reuses the status vocabulary of the comms connection cards rather than
 * inventing a second one, and says plainly what linking means: the credential
 * is stored server-side so unattended runs can use it.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.7.
 */

const STATUS_LABEL: Record<ModelSubscription['status'], string> = {
  active: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
  needs_reauthorization: 'Needs reconnecting',
}

const STATUS_TONE: Record<ModelSubscription['status'], string> = {
  active: 'var(--ok)',
  disconnected: 'var(--tx3)',
  error: 'var(--danger)',
  needs_reauthorization: 'var(--warning)',
}

const LinkDialog = ({
  onClose,
  provider,
}: {
  onClose: () => void
  provider: ModelSubscriptionProviderOption
}) => {
  const link = useLinkModelSubscription()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      await link.mutateAsync({ apiKey: apiKey.trim(), provider: provider.key })
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That key could not be linked.',
      )
    }
  }

  return (
    <Dialog
      onClose={onClose}
      open
      title={`Link ${provider.displayName}`}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[color:var(--tx2)]">{provider.termsNote}</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-[color:var(--tx1)]">
            Subscription key
          </span>
          <input
            autoComplete="off"
            className="admin-input"
            onChange={(event) => {
              setApiKey(event.target.value)
              // The message is a rejected submit, not a per-keystroke check, so
              // it clears on the next edit rather than re-announcing.
              setError(null)
            }}
            placeholder="Paste the key from your provider console"
            spellCheck={false}
            type="password"
            value={apiKey}
            {...fieldErrorAria('subscription-key', error ?? undefined)}
          />
        </label>
        {renderFieldError('subscription-key', error ?? undefined)}
        <div className="flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary admin-button-compact"
            disabled={apiKey.trim().length < 8 || link.isPending}
            onClick={() => void submit()}
            type="button"
          >
            {link.isPending ? 'Checking…' : 'Link subscription'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

const SubscriptionCard = ({ subscription }: { subscription: ModelSubscription }) => {
  const disconnect = useDisconnectModelSubscription()
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--bd1)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-[color:var(--tx1)]">
            {subscription.displayName}
          </span>
          {subscription.accountLabel ? (
            <span className="text-xs text-[color:var(--tx3)]">
              {subscription.accountLabel}
            </span>
          ) : null}
        </div>
        <span
          className="text-xs font-medium"
          style={{ color: STATUS_TONE[subscription.status] }}
        >
          {STATUS_LABEL[subscription.status]}
        </span>
      </div>
      {subscription.healthDetail ? (
        <p className="text-xs text-[color:var(--tx3)]">{subscription.healthDetail}</p>
      ) : null}
      <div className="flex justify-end">
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          disabled={disconnect.isPending}
          onClick={() => setConfirming(true)}
          type="button"
        >
          Disconnect
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog
          body="Agents set to run on this subscription will stop until you reconnect it or choose another model."
          confirmLabel="Disconnect"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void disconnect.mutateAsync(subscription.id).then(() => {
              setConfirming(false)
            })
          }}
          open
          pending={disconnect.isPending}
          title={`Disconnect ${subscription.displayName}?`}
        />
      ) : null}
    </div>
  )
}

export const ModelSubscriptionSection = () => {
  const providers = useModelSubscriptionProviders()
  const subscriptions = useModelSubscriptions()
  const [linking, setLinking] = useState<ModelSubscriptionProviderOption | null>(null)

  const rows = (subscriptions.data ?? []).filter((row) => row.status !== 'disconnected')
  const available = providers.data?.available ?? false

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-[color:var(--tx1)]">
          Personal model subscriptions
        </h2>
        <p className="text-sm text-[color:var(--tx2)]">
          Link a plan you already pay for, and the agents you own can run on it
          instead of your organisation’s credits. Your key is stored securely so
          your agents can keep working while you are away.
        </p>
      </div>

      <QueryState
        errorLabel="Could not load your subscriptions."
        loadingLabel="Loading subscriptions…"
        query={subscriptions}
      >
        {() => (
          !available ? (
            // Said plainly rather than discovered through a failed link: with no
            // vault there is nowhere safe to keep the credential.
            <EmptyState title="Not available on this deployment">
              Personal subscriptions need a credential vault, which this
              deployment has not configured. Ask an administrator to set one up.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState
              action={
                <div className="flex gap-2">
                  {(providers.data?.providers ?? []).map((provider) => (
                    <button
                      className="admin-button admin-button-primary admin-button-compact"
                      key={provider.key}
                      onClick={() => setLinking(provider)}
                      type="button"
                    >
                      Link {provider.displayName}
                    </button>
                  ))}
                </div>
              }
              title="No personal subscriptions linked"
            >
              Your agents run on your organisation’s credits until you link one.
            </EmptyState>
          ) : (
            <div className="grid gap-4">
              {rows.map((subscription) => (
                <SubscriptionCard key={subscription.id} subscription={subscription} />
              ))}
              <div className="flex gap-2">
                {(providers.data?.providers ?? []).map((provider) => (
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    key={provider.key}
                    onClick={() => setLinking(provider)}
                    type="button"
                  >
                    Link {provider.displayName}
                  </button>
                ))}
              </div>
            </div>
          )
        )}
      </QueryState>

      {/* Which dialog a provider gets is the adapter's own declaration: a
          pasted console key, or Nessie's own device-code sign-in. */}
      {linking
        ? linking.authStrategy === 'oauth_device'
          ? <DeviceLinkDialog onClose={() => setLinking(null)} provider={linking} />
          : <LinkDialog onClose={() => setLinking(null)} provider={linking} />
        : null}
    </section>
  )
}
