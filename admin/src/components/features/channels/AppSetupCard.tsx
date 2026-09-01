import { AppSetupCardSchema, type AppSetupCardPresenter } from '@nessie/schemas'
import { useMemo, useState } from 'react'

import {
  useAppConnectionRequestCard,
  useBeginAppConnectionRequest,
} from '../../../facades/app-connection-requests/hooks'
import { createAppConnectAuthorizationLauncher } from '../../../facades/apps/connect-hooks'
import { AppIcon } from '../apps/AppIcon'
import { Pill, type PillTone } from '../../primitives/Pill'

const statusCopy: Record<AppSetupCardPresenter['status'], string> = {
  awaiting_grant: 'Needs permission',
  awaiting_scope_upgrade: 'Needs a wider scope',
  cancelled: 'Cancelled',
  connecting: 'Signing in',
  expired: 'Expired',
  failed: 'Could not connect',
  needs_secret: 'Needs an API key',
  offered: 'Ready to connect',
  ready: 'Connected',
  selecting_resources: 'Choose what to connect',
  superseded: 'Replaced by a newer request',
}

const statusTone: Record<AppSetupCardPresenter['status'], PillTone> = {
  awaiting_grant: 'warning',
  awaiting_scope_upgrade: 'warning',
  cancelled: 'muted',
  connecting: 'accent',
  expired: 'muted',
  failed: 'danger',
  needs_secret: 'warning',
  offered: 'accent',
  ready: 'success',
  selecting_resources: 'warning',
  superseded: 'muted',
}

const detailFor = (card: AppSetupCardPresenter): string => {
  if (card.detail) return card.detail
  if (card.status === 'offered') {
    return `Choose an app for ${card.agent.name}. ${card.scope?.label ?? 'The selected scope'} stays visible before you connect.`
  }
  if (card.status === 'expired') return 'This connection request expired before an app was selected.'
  if (card.status === 'failed') return 'The connection did not finish. Open Apps to review the available connection.'
  if (card.status === 'ready') return `${card.agent.name} can now use the approved app access.`
  return 'This connection request is being updated.'
}

/**
 * First-party app setup card. Its message metadata holds only a request id;
 * every fact rendered here comes from the authenticated presenter query.
 */
export const AppSetupCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = AppSetupCardSchema.safeParse(metadata?.appSetupCard)
  const requestId = parsed.success ? parsed.data.card.requestId : undefined
  const request = useAppConnectionRequestCard(requestId)
  const begin = useBeginAppConnectionRequest()
  const [blockedAuthorizationUrl, setBlockedAuthorizationUrl] = useState<string | null>(null)
  const launcher = useMemo(
    () => createAppConnectAuthorizationLauncher(window),
    [],
  )

  const connect = (catalogEntryId: string) => {
    if (!requestId) return
    setBlockedAuthorizationUrl(null)
    begin.mutate(
      { catalogEntryId, requestId },
      {
        onSuccess: (result) => {
          if (result.status !== 'authorize') return
          // The URL lives only in this closure/component state. A reload or a
          // second device asks the server to mint a fresh authorization flow.
          if (launcher.open(result.authorizationUrl) === null) {
            setBlockedAuthorizationUrl(result.authorizationUrl)
          }
        },
      },
    )
  }

  return (
    <AppSetupCardView
      card={request.data}
      connectingCatalogEntryId={begin.isPending ? begin.variables?.catalogEntryId : undefined}
      onConnect={connect}
      requestId={requestId}
      unavailable={request.isError}
      blockedAuthorizationUrl={blockedAuthorizationUrl}
    />
  )
}

export const AppSetupCardView = ({
  card,
  blockedAuthorizationUrl,
  connectingCatalogEntryId,
  onConnect,
  requestId,
  unavailable,
}: {
  card: AppSetupCardPresenter | undefined
  blockedAuthorizationUrl?: string | null
  connectingCatalogEntryId?: string
  onConnect?: (catalogEntryId: string) => void
  requestId?: string
  unavailable: boolean
}) => {
  if (!requestId) return null
  if (unavailable) {
    return (
      <div className="mt-2 text-xs text-[color:var(--tx3)]" data-testid="app-setup-unavailable">
        App connection details are unavailable.
      </div>
    )
  }
  if (!card) return <div className="mt-2 text-xs text-[color:var(--tx3)]">Loading app connection…</div>

  return (
    <section
      className="mt-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3"
      data-testid="app-setup-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[color:var(--tx)]">Connect an app</p>
          <p className="mt-0.5 text-xs text-[color:var(--tx3)]">For {card.agent.name} · {card.scope?.label ?? 'No scope selected'}</p>
        </div>
        <Pill size="sm" tone={statusTone[card.status]}>{statusCopy[card.status]}</Pill>
      </div>
      <p className="mt-2 text-sm leading-5 text-[color:var(--tx2)]">{detailFor(card)}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {card.candidates.map((candidate) => (
          <div
            className="flex min-w-0 items-start gap-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-2"
            key={candidate.catalogEntryId}
          >
            <AppIcon displayName={candidate.displayName} iconUrl={candidate.iconUrl} size="card" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[color:var(--tx)]">{candidate.displayName}</p>
              <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-[color:var(--tx3)]">{candidate.shortDescription}</p>
              <p className="mt-1 text-[11px] text-[color:var(--tx3)]">
                {candidate.authMethod === 'oauth2' ? 'Sign-in required' : candidate.authMethod === 'none' ? 'No sign-in required' : 'API key required'}
                {candidate.capabilityCount === null ? '' : ` · ${candidate.capabilityCount} capabilities`}
              </p>
              {card.action === 'begin' && onConnect ? (
                <button
                  className="admin-button admin-button-primary admin-button-compact mt-2"
                  disabled={Boolean(connectingCatalogEntryId)}
                  onClick={(event) => {
                    event.stopPropagation()
                    onConnect(candidate.catalogEntryId)
                  }}
                  type="button"
                >
                  {connectingCatalogEntryId === candidate.catalogEntryId
                    ? 'Starting sign-in…'
                    : `Connect ${candidate.displayName}`}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {blockedAuthorizationUrl ? (
        <div
          className="mt-3 rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-soft)] p-3 text-sm text-[color:var(--warning-text)]"
          data-testid="app-setup-popup-blocked"
          role="alert"
        >
          <p>Your browser blocked the sign-in window. Open the sign-in directly instead.</p>
          <a
            className="admin-button admin-button-secondary admin-button-compact mt-2"
            href={blockedAuthorizationUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open sign-in ↗
          </a>
        </div>
      ) : null}
      {card.status === 'awaiting_grant' ? (
        <a
          className="admin-button admin-button-secondary admin-button-compact mt-3"
          href="/apps"
        >
          Manage app access
        </a>
      ) : null}
      {card.status === 'failed' && card.failureCode ? (
        <details className="mt-3 text-xs text-[color:var(--tx3)]">
          <summary className="cursor-pointer">Connection details</summary>
          <p className="mt-1 break-words">{card.failureCode}</p>
        </details>
      ) : null}
    </section>
  )
}
