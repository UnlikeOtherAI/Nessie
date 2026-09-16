import { columnIndexToLabel, type SpreadsheetActor } from '@nessie/schemas'
import { IdentityTile } from '../../../primitives/IdentityTile'

/**
 * Who else is in this document, and where.
 *
 * The strip is presence's *home*; Phase 3b's overlay is the in-context doorway
 * that draws the same peers on the grid itself. This component is deliberately
 * dumb — `peers` is a prop, so 3a ships the surface and 3b only has to feed it.
 *
 * Frames carry `displayName` and `color` on the actor, so a peer whose identity
 * cannot be resolved locally (an agent from a run this client never saw, a
 * person who left the org mid-session) still gets a tile rather than vanishing.
 */

export type SpreadsheetPeer = {
  actor: SpreadsheetActor
  /** Resolved elsewhere; the strip never decides which avatar source wins. */
  avatarUrl?: string | null
  cell?: { c: number; r: number } | null
  sheetName?: string
}

const MAX_TILES = 5

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

const whereLabel = (peer: SpreadsheetPeer): string => {
  if (!peer.cell) return peer.sheetName ? `on ${peer.sheetName}` : 'in this spreadsheet'
  const a1 = `${columnIndexToLabel(peer.cell.c)}${peer.cell.r}`
  return peer.sheetName ? `on ${peer.sheetName}, ${a1}` : `at ${a1}`
}

export const PresenceStrip = ({ peers }: { peers: SpreadsheetPeer[] }) => {
  if (peers.length === 0) return null
  const shown = peers.slice(0, MAX_TILES)
  const overflow = peers.length - shown.length

  return (
    <div
      aria-label="People and agents in this spreadsheet"
      className="flex items-center gap-1 px-3 py-1"
      data-testid="spreadsheet-presence-strip"
    >
      {shown.map((peer) => (
        <span
          className="inline-flex"
          key={`${peer.actor.type}:${peer.actor.id}`}
          title={`${peer.actor.displayName} — ${whereLabel(peer)}`}
        >
          <IdentityTile
            className="ring-2"
            fallback={{ kind: 'initials', text: initials(peer.actor.displayName) }}
            imageUrl={peer.avatarUrl ?? null}
            label={peer.actor.displayName}
            size={22}
            // The ring is the presence colour, which `presenceColorFor` derives
            // from the actor id so a person keeps it across sessions and
            // replicas — and so the strip and 3b's overlay always agree.
            style={{ boxShadow: `0 0 0 2px ${peer.actor.color}` }}
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="ml-1 text-xs text-[color:var(--tx3)]">+{overflow}</span>
      ) : null}
    </div>
  )
}
