import { Link } from 'react-router-dom'
import type { BoardSourceRecord } from '../../facades/board-sources/hooks'
import { PROVIDER_LABEL } from '../../facades/board-sources/hooks'
import { Pill } from '../primitives/Pill'

type SourceStatusStripProps = {
  projectId: string
  sources: BoardSourceRecord[]
}

/**
 * Every health state names its own remedy — the standard this follows is
 * docs/standards/capability-health-alerts.md, and the reason it is on the board
 * rather than only in Settings is that "is what I am looking at current?" is the
 * question a person answers immediately before dragging a card.
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

export const SourceStatusStrip = ({ projectId, sources }: SourceStatusStripProps) => {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map((source) => {
        const health = HEALTH[source.healthState]
        return (
          <Link
            key={source.id}
            to={`/projects/${projectId}/settings?section=sources&source=${source.id}`}
          >
            <Pill size="sm" tone={health.tone} uppercase={false}>
              {PROVIDER_LABEL[source.provider]} {source.name} ·{' '}
              {health.remedy ?? freshness(source.lastSyncCompletedAt)}
            </Pill>
          </Link>
        )
      })}
    </div>
  )
}
