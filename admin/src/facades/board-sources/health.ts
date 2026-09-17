import { PROVIDER_LABEL, type BoardSourceRecord } from './hooks'

/**
 * The one reading of a connected source's health, shared by every surface
 * that answers "is what I am looking at current?" — the board's Configure
 * menu today. It used to live inside `SourceStatusStrip`; when the strip
 * retired into the menu the logic moved here rather than being copied,
 * because two spellings of "synced 5 min ago" would drift.
 *
 * Every health state names its own remedy — the standard is
 * docs/standards/capability-health-alerts.md.
 */
export const SOURCE_HEALTH: Record<
  BoardSourceRecord['healthState'],
  { remedy: string | null; tone: 'danger' | 'muted' | 'warning' }
> = {
  active: { remedy: null, tone: 'muted' },
  paused: { remedy: 'Paused — resume', tone: 'warning' },
  needs_reauthorization: { remedy: 'Reconnect', tone: 'danger' },
  owner_inactive: { remedy: 'Connect as me', tone: 'danger' },
  misconfigured: { remedy: 'Edit mapping', tone: 'warning' },
  error: { remedy: 'Retry', tone: 'danger' },
}

export const sourceFreshness = (iso: string | null): string => {
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
export const sourceDelivery = (source: BoardSourceRecord): string | null => {
  if (source.webhookActive) return 'Live'
  if (source.pollingIntervalMinutes === null) return null
  return `every ${source.pollingIntervalMinutes} min`
}

/**
 * The sentence a surface shows under a source's name:
 * `Linear KiloMayo · synced 5 min ago · read-only · every 5 min`, with the
 * health remedy standing in for the freshness whenever there is one — the
 * remedy is the answer to the freshness question then.
 */
export const sourceStatusDetail = (source: BoardSourceRecord): string => {
  const remedy = SOURCE_HEALTH[source.healthState].remedy
  const mode = sourceDelivery(source)
  return [
    `${PROVIDER_LABEL[source.provider]} ${source.name}`,
    remedy ?? sourceFreshness(source.lastSyncCompletedAt),
    source.writeMode === 'read_only' ? 'read-only' : null,
    mode && !remedy ? mode : null,
  ].filter((part): part is string => part !== null).join(' · ')
}
