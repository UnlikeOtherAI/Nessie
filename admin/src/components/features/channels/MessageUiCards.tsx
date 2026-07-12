import { IntegrationUiCardSchema, type IntegrationUiCard } from '@nessie/schemas'
import { AgentActivityTimeline } from './AgentActivityTimeline'

type IntegrationUiCardAction = NonNullable<IntegrationUiCard['actions']>[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const readIntegrationCards = (
  metadata: Record<string, unknown> | undefined,
): IntegrationUiCard[] => {
  const rawCards = metadata?.uiCards
  if (!Array.isArray(rawCards)) {
    return []
  }

  return rawCards.flatMap((rawCard) => {
    if (!isRecord(rawCard)) {
      return []
    }
    const parsed = IntegrationUiCardSchema.safeParse(rawCard)
    return parsed.success ? [parsed.data] : []
  })
}

const productLabel = (slug: string | undefined): string => {
  if (slug === 'deep-water') return 'Deep Water'
  if (slug === 'deeptest') return 'DeepTest'
  if (slug === 'buildme') return 'buildme.live'
  if (slug === 'deepsignal') return 'DeepSignal'
  return 'Integration'
}

const statusLabel = (status: IntegrationUiCard['status']): string =>
  status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const statusClass = (status: IntegrationUiCard['status']): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    status === 'completed'
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : status === 'failed'
        ? 'bg-[var(--danger-soft)] text-[var(--danger-text)]'
        : status === 'warning' || status === 'needs_setup'
          ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
          : status === 'running' || status === 'queued'
            ? 'bg-[var(--accent-soft)] text-[var(--thinking)]'
            : 'bg-[var(--overlay)] text-[var(--tx2)]',
  ].join(' ')

const actionClass = (variant: IntegrationUiCardAction['variant']): string =>
  [
    'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold',
    variant === 'primary'
      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
      : 'border border-[var(--sep)] bg-[var(--overlay-weak)] text-[var(--tx2)]',
  ].join(' ')

const LaunchIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MessageUiCard = ({ card }: { card: IntegrationUiCard }) => (
  <div className="rounded-lg border border-[var(--sep)] bg-[var(--panel)] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold uppercase text-[var(--tx3)]">
        {productLabel(card.productSlug)}
      </span>
      <span className={statusClass(card.status)}>{statusLabel(card.status)}</span>
    </div>
    <div className="mt-2 text-sm font-semibold text-[var(--tx)]">{card.title}</div>
    {card.summary ? (
      <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">{card.summary}</p>
    ) : null}
    {card.fields?.length ? (
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {card.fields.map((field) => (
          <div className="min-w-0 rounded border border-[var(--sep)] px-2 py-1.5" key={field.label}>
            <dt className="truncate text-[11px] font-semibold uppercase text-[var(--tx3)]">
              {field.label}
            </dt>
            <dd className="truncate text-xs text-[var(--tx)]">{field.value}</dd>
          </div>
        ))}
      </dl>
    ) : null}
    {card.actions?.length ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.map((action) =>
          action.href ? (
            <a
              className={`${actionClass(action.variant)} gap-1.5`}
              href={action.href}
              key={`${action.label}:${action.href}`}
              rel="noreferrer"
              target={action.href.startsWith('http') ? '_blank' : undefined}
            >
              {action.label}
              {action.href.startsWith('http') ? <LaunchIcon /> : null}
            </a>
          ) : (
            <span
              className={`${actionClass(action.variant)} cursor-default gap-1.5 opacity-60`}
              key={action.label}
            >
              {action.label}
            </span>
          ),
        )}
      </div>
    ) : null}
  </div>
)

export const MessageUiCards = ({
  metadata,
  // External-agent assistant turns render their `role: 'activity'` cards as a
  // collapsed plan/timeline (the reasoning view); result cards stay flat. For
  // every other surface all cards render flat, exactly as before.
  isExternalAgent = false,
}: {
  metadata: Record<string, unknown> | undefined
  isExternalAgent?: boolean
}) => {
  const cards = readIntegrationCards(metadata)
  if (cards.length === 0) {
    return null
  }

  const activities = isExternalAgent
    ? cards.filter((card) => card.role === 'activity')
    : []
  const flatCards = isExternalAgent
    ? cards.filter((card) => card.role !== 'activity')
    : cards

  return (
    <>
      {activities.length > 0 ? <AgentActivityTimeline activities={activities} /> : null}
      {flatCards.length > 0 ? (
        <div className="mt-2 grid max-w-2xl gap-2">
          {flatCards.map((card, index) => (
            <MessageUiCard card={card} key={`${card.kind}:${card.title}:${index}`} />
          ))}
        </div>
      ) : null}
    </>
  )
}
