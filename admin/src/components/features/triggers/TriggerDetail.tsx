import { useTriggerHistory } from '../../../facades/triggers/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { getBaseUrl } from '../../../lib/api-client'
import { CopyField } from '../../shared/CopyField'
import { EmptyState } from '../../shared/EmptyState'
import { KeyValueList } from '../../shared/KeyValueList'
import { Row, RowList } from '../../shared/RowList'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import {
  formatTriggerDeliveryPayload,
  formatRelativeTime,
  formatTimestamp,
  formatTriggerTarget,
  getDeliveryStatusColor,
  getRollingStatusLabel,
  getScheduleSummary,
  getTriggerEventNames,
  type TriggerRegistryMaps,
} from './trigger-presentation'
import { useTicketTriggerFacts } from './ticket-trigger-facts'
import { ticketDeliveryLine } from '../ticket-work/ticket-work-presentation'

/**
 * What a trigger *is*, on its own screen: its description, one definition list
 * of facts, its webhook endpoint where it has one, and what it has actually
 * delivered.
 *
 * It runs nothing. Running, pausing, reauthorizing, editing and deleting are
 * the screen's actions and live in `ScreenHeader`'s measured lane on
 * `TriggerDetailPage`, with the one health banner that offers the recovery
 * beside them — so no fact and no control is written twice.
 */

type TriggerDetailProps = {
  registry: TriggerRegistryMaps
  trigger: AgentTriggerRecord
}

export const TriggerDetail = ({ registry, trigger }: TriggerDetailProps) => {
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)
  const webhookBaseUrl = getBaseUrl() || window.location.origin.replace(/\/$/, '')
  const eventNames = getTriggerEventNames(trigger)
  const nextRunRelative = formatRelativeTime(trigger.nextRunAt)
  const ticketFacts = useTicketTriggerFacts(trigger, registry)

  return (
    <div className="grid max-w-3xl gap-5">
      {trigger.description ? (
        <p className="text-sm leading-6 text-[color:var(--tx2)]">{trigger.description}</p>
      ) : null}

      {/* Facts: one definition list, no repeated facts */}
      <KeyValueList
        items={[
          { label: 'Target', value: formatTriggerTarget(trigger, registry) },
          // A ticket trigger's facts below say when it acts, column by column.
          ...(trigger.type === 'ticket_changed' ? [] : [{ label: 'Schedule', value: getScheduleSummary(trigger) }]),
          ...(trigger.status === 'active'
            && (trigger.nextRunAt || trigger.type === 'scheduled' || trigger.type === 'interval')
            ? [
                {
                  label: 'Next run',
                  value: trigger.nextRunAt
                    ? `${formatTimestamp(trigger.nextRunAt)}${nextRunRelative ? ` · ${nextRunRelative}` : ''}`
                    : '—',
                },
              ]
            : []),
          { label: 'Last fired', value: formatTimestamp(trigger.lastFiredAt) },
          ...(eventNames.length > 0
            ? [{ label: 'Events', value: eventNames.join(', ') }]
            : []),
          ...(getRollingStatusLabel(trigger)
            ? [{ label: 'Quiet runs', value: getRollingStatusLabel(trigger) }]
            : []),
          ...ticketFacts,
        ]}
      />

      {trigger.type === 'webhook' ? (
        <section>
          <SectionLabel>Webhook endpoint</SectionLabel>
          <p className="mt-1 text-xs text-[color:var(--tx3)]">
            POST to this endpoint with the API key as a bearer token to fire
            the trigger.
          </p>
          <div className="mt-3 grid gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
            <CopyField label="Endpoint" value={`${webhookBaseUrl}/api/triggers/webhook`} />
            {trigger.webhookApiKey ? (
              <CopyField label="API key" value={trigger.webhookApiKey} />
            ) : (
              <div className="text-xs text-[color:var(--tx3)]">
                No API key generated yet.
              </div>
            )}
          </div>
        </section>
      ) : null}

      <section>
        <SectionLabel>Recent deliveries</SectionLabel>
        {history.length === 0 ? (
          <EmptyState className="mt-3">
            No deliveries yet.
          </EmptyState>
        ) : (
          <RowList className="mt-3" label="Recent deliveries">
            {history.map((delivery) => {
              // A ticket delivery says what it decided and why, in words: a
              // skip is exactly the answer to "I moved it and nothing happened".
              const ticketLine = ticketDeliveryLine(delivery.payload)
              return (
                <Row
                  key={delivery.id}
                  leading={
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: getDeliveryStatusColor(delivery.status) }}
                    />
                  }
                  title={
                    <span className="flex items-center gap-2">
                      <span>{delivery.status}</span>
                      <span className="font-normal text-xs text-[color:var(--tx3)]">
                        {delivery.source ?? 'manual'}
                        {delivery.runId ? ` · run ${delivery.runId.slice(0, 8)}` : ''}
                      </span>
                      {/* The delivery reached a worker; whether the run then
                          succeeded is a different question, and the one the
                          owner is actually asking when a schedule looks broken. */}
                      {delivery.runStatus && delivery.runStatus !== 'completed' ? (
                        <Pill radius="chip" size="sm" tone="danger" uppercase={false}>
                          run {delivery.runStatus}
                        </Pill>
                      ) : null}
                    </span>
                  }
                  trailing={
                    <span className="text-xs tabular-nums text-[color:var(--tx3)]">
                      {formatTimestamp(delivery.createdAt)}
                    </span>
                  }
                >
                  {ticketLine ? (
                    <div className="mt-1 text-xs text-[color:var(--tx2)]" data-testid="ticket-delivery-line">
                      {ticketLine}
                    </div>
                  ) : null}
                  {delivery.errorMessage && !(ticketLine && delivery.status === 'skipped') ? (
                    <div className="mt-1 text-xs text-[var(--danger-text)]">
                      {delivery.errorMessage}
                    </div>
                  ) : null}
                  <details className="mt-2">
                    <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] hover:text-[color:var(--tx2)]">
                      Payload
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[color:var(--tx2)]">
                      {formatTriggerDeliveryPayload(delivery.payload)}
                    </pre>
                  </details>
                </Row>
              )
            })}
          </RowList>
        )}
      </section>
    </div>
  )
}
