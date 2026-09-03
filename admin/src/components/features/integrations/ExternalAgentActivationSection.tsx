import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { IntegratedProductResponse } from '../../../lib/api-client'
import {
  useActivateExternalAgentProduct,
  useDeactivateExternalAgentProduct,
} from '../../../facades/integrations/hooks'
import { Notice } from '../../primitives/Notice'

/**
 * Per-user activation for a product that is a peer external agent (DeepSignal
 * today) rather than a shared team install. The user's existing Nessie UOA SSO
 * link supplies actor/team identity; the product-bound app key stays on
 * the server. Activation never opens a second OAuth flow.
 */
export const ExternalAgentActivationSection = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const activate = useActivateExternalAgentProduct()
  const deactivate = useDeactivateExternalAgentProduct()
  const [channelId, setChannelId] = useState<string | null>(null)

  if (!product.capabilities.includes('external_agent')) {
    return null
  }

  const teamEnabled = product.teamEnablement?.enabled ?? false
  const status = product.accountLink?.status ?? null
  const isLinked = status === 'linked'
  const runActivate = (onLinked?: (nextChannelId: string) => void) => {
    activate.mutate(product.slug, {
      onSuccess: (result) => {
        setChannelId(result.channelId)
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
        setChannelId(null)
      },
    })
  }

  return (
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">Your access</h3>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            {isLinked
              ? 'Activated for you — chat with it in its own private channel.'
              : teamEnabled
                ? 'Activate it using your existing UnlikeOtherAI SSO identity.'
                : 'Ask an owner to enable team access before you can activate it.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isLinked ? (
            <>
              <button
                className="admin-button admin-button-primary admin-button-compact"
                onClick={openChannel}
                type="button"
              >
                Open channel
              </button>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                disabled={deactivate.isPending}
                onClick={runDeactivate}
                type="button"
              >
                {deactivate.isPending ? 'Deactivating...' : 'Deactivate'}
              </button>
            </>
          ) : (
            <button
              className="admin-button admin-button-primary admin-button-compact"
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
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {activate.error instanceof Error ? activate.error.message : 'Failed to activate.'}
        </Notice>
      ) : null}
      {deactivate.isError ? (
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {deactivate.error instanceof Error ? deactivate.error.message : 'Failed to deactivate.'}
        </Notice>
      ) : null}
    </section>
  )
}
