import { Link } from 'react-router-dom'
import type { BoardSourceRecord } from '../../facades/board-sources/hooks'
import {
  PROVIDER_LABEL,
  isSourceSyncing,
  useSourceAction,
} from '../../facades/board-sources/hooks'
import { Pill } from '../primitives/Pill'

type SourceStatusStripProps = {
  canAdminister: boolean
  projectId: string
  sources: BoardSourceRecord[]
}

/**
 * Every health state names its own remedy — the standard this follows is
 * docs/standards/capability-health-alerts.md, and the reason it is on the board
 * rather than only in Settings is that "is what I am looking at current?" is the
 * question a person answers immediately before dragging a card.
 *
 * The Sync control is here for the same reason. The answer to "this looks
 * stale" is one press, and sending somebody to Settings to find it was a
 * doorway missing from the screen where the question is asked.
 */
const HEALTH: Record<
  BoardSourceRecord['healthState'],
  { tone: 'danger' | 'muted' | 'warning'; remedy: string | null }
> = {
  active: { tone: 'muted', remedy: null },
  paused: { tone: 'warning', remedy: 'Paused — resume' },
  needs_reauthorization: { tone: 'danger', remedy: 'Reconnect' },
  owner_inactive: { tone: 'danger', remedy: 'Connect as me' },
  misconfigured: { tone: 'warning', remedy: 'Edit mapping' },
  error: { tone: 'danger', remedy: 'Retry' },
}

const freshness = (iso: string | null): string => {
  if (!iso) return 'not synced yet'
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes)) return 'not synced yet'
  if (minutes < 1) return 'synced just now'
  if (minutes < 60) return `synced ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `synced ${hours}h ago`
  return `synced ${Math.round(hours / 24)}d ago`
}

/**
 * How this source hears about a change: pushed by the provider, or noticed on
 * the next poll. Named because the difference is seconds against minutes, and
 * because a person who has just pressed Sync twice deserves to know which one
 * they are waiting for.
 */
const delivery = (source: BoardSourceRecord): string | null => {
  if (source.webhookActive) return 'Live'
  if (source.pollingIntervalMinutes === null) return null
  return `every ${source.pollingIntervalMinutes} min`
}

export const SourceStatusStrip = ({
  canAdminister,
  projectId,
  sources,
}: SourceStatusStripProps) => {
  const action = useSourceAction(projectId)
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map((source) => {
        const health = HEALTH[source.healthState]
        const syncing = isSourceSyncing(source)
        const mode = delivery(source)
        return (
          <span className="flex items-center gap-1" key={source.id}>
            <Link to={`/projects/${projectId}/settings?section=sources&source=${source.id}`}>
              <Pill size="sm" tone={health.tone} uppercase={false}>
                {PROVIDER_LABEL[source.provider]} {source.name} ·{' '}
                {health.remedy ??
                  (syncing ? 'syncing…' : freshness(source.lastSyncCompletedAt))}
                {mode && !health.remedy ? ` · ${mode}` : ''}
              </Pill>
            </Link>
            {canAdminister ? (
              <button
                className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]
                  disabled:opacity-50"
                disabled={syncing || action.isPending}
                onClick={() => action.mutate({ id: source.id, action: 'sync' })}
                title={`Sync ${source.name} from ${PROVIDER_LABEL[source.provider]} now`}
                type="button"
              >
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
