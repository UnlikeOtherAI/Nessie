import { AgentCardMessageMetadataSchema, BROWSER_VIEWPORT_PRESETS, type AgentCardPresenter } from '@nessie/schemas'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { useViewport, type ViewportSnapshot } from '../../../hooks/useViewport'
import { useAgentCard, useRespondToAgentCard } from '../../../facades/agent-cards/hooks'
import {
  useActivatePersonalBrowserAccessGrant,
  useRevokePersonalBrowserAccessGrant,
} from '../../../facades/browser-cloud/hooks'
import { FormError } from '../../shared/FormActions'
import { AppIcon } from '../apps/AppIcon'
import { Pill, type PillTone } from '../../primitives/Pill'
import { AgentCardBlocks, type AgentCardFieldValue } from './AgentCardBlocks'

const statusCopy: Record<AgentCardPresenter['status'], string> = {
  cancelled: 'Cancelled',
  expired: 'Expired',
  open: 'Waiting',
  resolved: 'Answered',
}

const statusTone: Record<AgentCardPresenter['status'], PillTone> = {
  cancelled: 'muted',
  expired: 'muted',
  open: 'accent',
  resolved: 'success',
}

const actionClass = (style: 'primary' | 'secondary' | 'danger'): string =>
  [
    'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-50',
    style === 'primary'
      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
      : style === 'danger'
        ? 'bg-[var(--danger)] text-[var(--on-accent)]'
        : 'border border-[color:var(--sep)] bg-[var(--overlay-weak)] text-[color:var(--tx2)]',
  ].join(' ')

const seedValues = (card: AgentCardPresenter): Record<string, AgentCardFieldValue> => {
  const seeded: Record<string, AgentCardFieldValue> = {}
  for (const block of card.blocks) {
    if (block.type === 'input' && block.default !== undefined) {
      seeded[block.key] = block.default
    }
  }
  return seeded
}

const personalBrowserViewport = (viewport: ViewportSnapshot): { height: number; width: number } => {
  const preset = viewport.atLeast.lg ? 'laptop' : viewport.atLeast.md ? 'tablet' : 'phone'
  return BROWSER_VIEWPORT_PRESETS.find((option) => option.id === preset)!.viewport
}

/**
 * An agent chat card. Its message metadata holds only a card id; every fact
 * rendered here — including whether this viewer may press anything — comes
 * from the authenticated, viewer-scoped presenter.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */
export const AgentCardMessage = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = AgentCardMessageMetadataSchema.safeParse(metadata)
  const cardId = parsed.success ? parsed.data.agentCard.cardId : undefined
  const { channelId } = useParams<{ channelId?: string }>()
  const viewport = useViewport()
  const navigate = useNavigate()
  const query = useAgentCard(cardId)
  const respond = useRespondToAgentCard()
  const activateBrowser = useActivatePersonalBrowserAccessGrant()
  const revokeBrowser = useRevokePersonalBrowserAccessGrant()

  const [values, setValues] = useState<Record<string, AgentCardFieldValue> | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const [temporarySessionId, setTemporarySessionId] = useState<string | null>(null)
  const [loginCancelled, setLoginCancelled] = useState(false)
  // Secrets live only here, are never seeded from the server, and are dropped
  // the moment the press succeeds.
  const [secrets, setSecrets] = useState<Record<string, string>>({})

  if (!cardId) return null
  const card = query.data
  if (!card) return null

  // A settled card shows what the server recorded, never leftover local form
  // state — the two are different facts and only one of them is the answer.
  const effectiveValues =
    card.status === 'open' ? values ?? seedValues(card) : card.resolution?.values ?? {}
  const canRespond = card.action === 'respond'

  const press = (actionKey: string, submits: boolean) => {
    setSubmissionError(null)
    respond.mutate(
      {
        actionKey,
        cardId: card.cardId,
        threadId: card.threadId,
        ...(submits ? { secrets, values: effectiveValues } : {}),
        ...(card.browserLogin && actionKey === 'done' && temporarySessionId
          ? { handoverSessionId: temporarySessionId }
          : {}),
      },
      {
        // Keep the API-authored refusal by the still-open form. A toast leaves
        // before a person can correct a masked field and offers no context.
        onError: (error) => {
          setSubmissionError(error.message)
        },
        onSuccess: () => {
          setSecrets({})
          setSubmissionError(null)
        },
      },
    )
  }

  const startPrivateBrowser = () => {
    if (!card.browserLogin) return
    setSubmissionError(null)
    activateBrowser.mutate({
      grantId: card.browserLogin.grantId,
      viewport: personalBrowserViewport(viewport),
    }, {
      onError: (error: Error) => setSubmissionError(error.message),
      onSuccess: (result) => {
        setTemporarySessionId(result.sessionId)
        if (channelId) navigate(`/channels/${channelId}/tools/browser?threadId=${encodeURIComponent(card.threadId)}`)
      },
    })
  }
  const cancelPrivateBrowser = () => {
    if (!card.browserLogin) return
    revokeBrowser.mutate(card.browserLogin.grantId, {
      onError: (error: Error) => setSubmissionError(error.message),
      onSuccess: () => {
        setLoginCancelled(true)
        setTemporarySessionId(null)
      },
    })
  }

  return (
    <section
      className={[
        'mt-2 max-w-2xl rounded-[var(--radius-lg)] border border-[color:var(--line)]',
        'bg-[color:var(--panel-soft)] p-3',
      ].join(' ')}
      data-testid="agent-card"
    >
      <header className="flex items-start gap-2">
        {card.service ? (
          <AppIcon
            displayName={card.service.label}
            iconUrl={card.service.iconUrl}
            size="badge"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-sm font-semibold text-[color:var(--tx1)]">
              {card.title}
            </h3>
            <Pill size="sm" tone={statusTone[card.status]}>
              {statusCopy[card.status]}
            </Pill>
          </div>
          {card.subtitle ? (
            <p className="m-0 text-xs text-[color:var(--tx2)]">{card.subtitle}</p>
          ) : null}
        </div>
      </header>

      <div className="mt-3">
        <AgentCardBlocks
          blocks={card.blocks}
          disabled={!canRespond || respond.isPending}
          providedSecretKeys={Object.keys(card.resolution?.secrets ?? {})}
          settled={card.status !== 'open'}
          onSecretChange={(key, value) =>
            {
              setSubmissionError(null)
              setSecrets((current) => ({ ...current, [key]: value }))
            }
          }
          onValueChange={(key, value) =>
            {
              setSubmissionError(null)
              setValues((current) => ({ ...(current ?? seedValues(card)), [key]: value }))
            }
          }
          secrets={secrets}
          values={effectiveValues}
        />
      </div>

      {card.browserLogin ? (
        <div className="mt-3 rounded-md border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3 text-xs text-[color:var(--tx2)]">
          <p className="m-0 font-medium text-[color:var(--tx)]">Private, one-time access</p>
          <p className="mt-1 mb-0">Only you can open this browser. It ends {new Date(card.browserLogin.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
          <p className="mt-1 mb-0">Allowed for this task: {card.browserLogin.origins.join(', ')}.</p>
          <p className="mt-1 mb-0">Nessie relays browser input privately; it never enters chat or the agent context.</p>
        </div>
      ) : null}

      <FormError className="mt-3">{submissionError}</FormError>

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {card.status === 'open' ? (
          canRespond ? (
            <>
              {card.browserLogin && !temporarySessionId && !loginCancelled ? (
                <button
                  className={actionClass('primary')}
                  disabled={activateBrowser.isPending || revokeBrowser.isPending || respond.isPending}
                  onClick={startPrivateBrowser}
                  type="button"
                >
                  {activateBrowser.isPending ? 'Starting private browser…' : 'Start private browser'}
                </button>
              ) : null}
              {card.browserLogin && temporarySessionId ? (
                <button
                  className={actionClass('secondary')}
                  disabled={revokeBrowser.isPending || respond.isPending}
                  onClick={cancelPrivateBrowser}
                  type="button"
                >
                  {revokeBrowser.isPending ? 'Cancelling…' : 'Cancel private access'}
                </button>
              ) : null}
              {loginCancelled ? <span className="text-xs text-[color:var(--tx2)]">Private access was cancelled. Ask the agent to request it again.</span> : null}
              {card.actions.map((action) => (
              <button
                className={actionClass(action.style)}
                data-testid={`agent-card-action-${action.key}`}
                disabled={respond.isPending || (card.browserLogin !== null
                  && action.key === 'done' && !temporarySessionId)}
                key={action.key}
                onClick={(event) => {
                  event.stopPropagation()
                  press(action.key, action.submits)
                }}
                type="button"
              >
                {action.label}
              </button>
              ))}
            </>
          ) : (
            <span className="text-xs text-[color:var(--tx2)]">
              {card.waitingFor.length > 0
                ? `Waiting for ${card.waitingFor.join(', ')}`
                : 'Waiting for an answer'}
            </span>
          )
        ) : card.resolution ? (
          // Who and when. The submitted values render in the body above, so
          // repeating them here would say everything twice.
          <span className="text-xs text-[color:var(--tx2)]">
            {card.resolution.byName
              ? `${card.resolution.actionLabel} by ${card.resolution.byName}`
              : card.resolution.actionLabel}
            {` · ${new Date(card.resolution.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}`}
          </span>
        ) : (
          <span className="text-xs text-[color:var(--tx2)]">
            {statusCopy[card.status]}
          </span>
        )}
      </footer>
    </section>
  )
}
