import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { IntegratedProductResponse } from '../../../lib/api-client'
import {
  useActivateExternalAgentProduct,
  useDeactivateExternalAgentProduct,
} from '../../../facades/integrations/hooks'

/**
 * Per-user activation for a product that is a peer external agent (DeepSignal
 * today) rather than a shared team install: team-enabled users sign in with
 * their own account and get a private DM channel proxied to the product over
 * MCP. Keyed off `capabilities.includes('external_agent')` so a second
 * external agent surfaces this section from data alone, no new component.
 *
 * Activation is idempotent on the backend, so this section reuses one mutation
 * for every step: the first click starts it (and opens the sign-in tab when
 * needed), and "I've signed in" re-calls the same endpoint to resolve the now
 * -active instance into a `linked` account and a channel to open.
 */
export const ExternalAgentActivationSection = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const activate = useActivateExternalAgentProduct()
  const deactivate = useDeactivateExternalAgentProduct()
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
  const [channelId, setChannelId] = useState<string | null>(null)

  if (!product.capabilities.includes('external_agent')) {
    return null
  }

  const teamEnabled = product.teamEnablement?.enabled ?? false
  const status = product.accountLink?.status ?? null
  const isLinked = status === 'linked'
  const isAwaitingSignIn = authorizeUrl !== null || status === 'needs_auth'

  const runActivate = (onLinked?: (nextChannelId: string) => void) => {
    activate.mutate(product.slug, {
      onSuccess: (result) => {
        setChannelId(result.channelId)
        if (result.authorizeUrl) {
          setAuthorizeUrl(result.authorizeUrl)
          window.open(result.authorizeUrl, '_blank', 'noopener')
          return
        }
        setAuthorizeUrl(null)
        onLinked?.(result.channelId)
      },
    })
  }

  const openChannel = () => {
    if (channelId) {
      void navigate(`/channels/${channelId}`)
      return
    }
    runActivate((nextChannelId) => void navigate(`/channels/${nextChannelId}`))
  }

  const runDeactivate = () => {
    deactivate.mutate(product.slug, {
      onSuccess: () => {
        setAuthorizeUrl(null)
        setChannelId(null)
      },
    })
  }

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Your access</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            {isLinked
              ? 'Activated for you — chat with it in its own private channel.'
              : isAwaitingSignIn
                ? 'Finish signing in with your account in the tab that just opened.'
                : teamEnabled
                  ? 'Activate it for yourself and sign in with your own account.'
                  : 'Ask an owner to enable team access before you can activate it.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isLinked ? (
            <>
              <button
                className="admin-button admin-button-primary text-xs"
                onClick={openChannel}
                type="button"
              >
                Open channel
              </button>
              <button
                className="admin-button admin-button-secondary text-xs"
                disabled={deactivate.isPending}
                onClick={runDeactivate}
                type="button"
              >
                {deactivate.isPending ? 'Deactivating...' : 'Deactivate'}
              </button>
            </>
          ) : isAwaitingSignIn ? (
            <>
              <button
                className="admin-button admin-button-secondary text-xs"
                disabled={!authorizeUrl}
                onClick={() => {
                  if (authorizeUrl) {
                    window.open(authorizeUrl, '_blank', 'noopener')
                  }
                }}
                type="button"
              >
                Reopen sign-in
              </button>
              <button
                className="admin-button admin-button-primary text-xs"
                disabled={activate.isPending}
                onClick={() => runActivate()}
                type="button"
              >
                {activate.isPending ? 'Checking...' : "I've signed in"}
              </button>
            </>
          ) : (
            <button
              className="admin-button admin-button-primary text-xs"
              disabled={!teamEnabled || activate.isPending}
              onClick={() => runActivate()}
              type="button"
            >
              {activate.isPending ? 'Activating...' : 'Activate for me'}
            </button>
          )}
        </div>
      </div>
      {activate.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {activate.error instanceof Error ? activate.error.message : 'Failed to activate.'}
        </p>
      ) : null}
      {deactivate.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {deactivate.error instanceof Error ? deactivate.error.message : 'Failed to deactivate.'}
        </p>
      ) : null}
    </section>
  )
}
