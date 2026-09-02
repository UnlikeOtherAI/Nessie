import { AgentCardMessageMetadataSchema, type AgentCardPresenter } from '@nessie/schemas'
import { useState } from 'react'

import { useAgentCard, useRespondToAgentCard } from '../../../facades/agent-cards/hooks'
import { useToasts } from '../../../providers/ToastProvider'
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
  const query = useAgentCard(cardId)
  const respond = useRespondToAgentCard()
  const { pushToast } = useToasts()

  const [values, setValues] = useState<Record<string, AgentCardFieldValue> | null>(null)
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
    respond.mutate(
      {
        actionKey,
        cardId: card.cardId,
        threadId: card.threadId,
        ...(submits ? { secrets, values: effectiveValues } : {}),
      },
      {
        // Every refusal is authored by the API; the toast repeats it verbatim.
        onError: (error) => {
          pushToast({ body: error.message, title: 'Could not send your answer' })
        },
        onSuccess: () => {
          setSecrets({})
        },
      },
    )
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
            setSecrets((current) => ({ ...current, [key]: value }))
          }
          onValueChange={(key, value) =>
            setValues((current) => ({ ...(current ?? seedValues(card)), [key]: value }))
          }
          secrets={secrets}
          values={effectiveValues}
        />
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {card.status === 'open' ? (
          canRespond ? (
            card.actions.map((action) => (
              <button
                className={actionClass(action.style)}
                data-testid={`agent-card-action-${action.key}`}
                disabled={respond.isPending}
                key={action.key}
                onClick={(event) => {
                  event.stopPropagation()
                  press(action.key, action.submits)
                }}
                type="button"
              >
                {action.label}
              </button>
            ))
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
