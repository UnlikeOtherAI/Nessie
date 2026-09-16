import { useEffect, useState } from 'react'
import type { Model } from '@ironcalc/wasm'
import { columnIndexToLabel, type SpreadsheetPresenceEvent } from '@nessie/schemas'
import { cellRect, HEADER_COLUMN_WIDTH, HEADER_ROW_HEIGHT } from '../spreadsheet-geometry'
import type { TouchSelectionHandle } from './useTouchSelection'

/**
 * Everybody else, drawn on the grid: their range as a translucent fill in
 * their own colour, a name tag at their cursor, and the text they are typing
 * ghosted inside the cell **before they press Enter**.
 *
 * The strip above the grid is presence's *home* (Rule zero); this is the
 * in-context doorway, and it answers the question the strip cannot — not "who
 * is here" but "do not touch that row, Dana is in it".
 *
 * It never touches IronCalc's canvas. Everything is absolutely positioned in a
 * layer over the pane, placed by the same `cellRect` the filter funnels use,
 * so the two layers can never disagree about where B4 is. Peers on another
 * sheet are deliberately absent: they appear in the strip with their sheet
 * name, because drawing a rectangle for a range that is not on screen would be
 * a lie about where they are.
 *
 * An agent is drawn exactly as a person — same rectangle, same tag, same draft
 * ghost — with a glyph before the name. That is the point of the whole lane:
 * Phase 4 publishes an agent's frames through the same route, and nothing here
 * branches on `actor.type` except for that one glyph.
 *
 * Each mark carries a stable class name — `spreadsheet-presence-cursor`,
 * `-label`, `-draft` — beside its `data-testid`. The class is the name the
 * other phases' cases reach for, and it survives a change of test id; the test
 * id stays because the rest of this suite is written in them.
 */

type PresenceOverlayProps = {
  /** The positioned element this layer fills; offsets are measured against it. */
  bounds: HTMLElement | null
  /** IronCalc's scroll element, the frame `cellRect` answers in. */
  container: HTMLElement | null
  model: Model | null
  peers: SpreadsheetPresenceEvent[]
  /** Bumped after every applied batch, to force a re-measure. */
  revision: number
  sheet: number
  /** Drawn by the touch layer; empty on a pointer device. */
  touchHandles?: TouchSelectionHandle[]
}

type PlacedPeer = {
  clientId: string
  color: string
  draft: { left: number; text: string; top: number; width: number } | null
  isAgent: boolean
  name: string
  /** The name tag sits above the cursor cell, or below it at the top edge. */
  tag: { below: boolean; left: number; top: number } | null
  rect: { height: number; left: number; top: number; width: number } | null
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

export const PresenceOverlay = ({
  bounds,
  container,
  model,
  peers,
  revision,
  sheet,
  touchHandles = [],
}: PresenceOverlayProps) => {
  const [placed, setPlaced] = useState<PlacedPeer[]>([])

  // Peers on this sheet only, and identified by the frame's own fields so a
  // peer this client cannot resolve locally still gets drawn.
  const onSheet = peers.filter((peer) => peer.sheet === sheet)
  const key = onSheet
    .map((peer) =>
      [
        peer.clientId,
        peer.selection.r0, peer.selection.c0, peer.selection.r1, peer.selection.c1,
        peer.cursor?.r, peer.cursor?.c,
        peer.draft?.r, peer.draft?.c, peer.draft?.text,
      ].join(':'))
    .join('|')

  useEffect(() => {
    if (!model || !container || !bounds) { setPlaced([]); return undefined }
    const measure = (): void => {
      const frame = container.getBoundingClientRect()
      const origin = bounds.getBoundingClientRect()
      const dx = frame.left - origin.left
      const dy = frame.top - origin.top
      const next: PlacedPeer[] = []
      for (const peer of onSheet) {
        const start = cellRect(model, sheet, peer.selection.r0, peer.selection.c0)
        const end = cellRect(model, sheet, peer.selection.r1, peer.selection.c1)
        const left = start.left
        const top = start.top
        const width = end.left + end.width - start.left
        const height = end.top + end.height - start.top
        // Clipped to the scrollable area rather than hidden outright: half a
        // rectangle at the edge still says "they are just off screen there",
        // which is the whole job. A rectangle wholly outside is dropped.
        const visible =
          left + width > HEADER_COLUMN_WIDTH
          && top + height > HEADER_ROW_HEIGHT
          && left < frame.width
          && top < frame.height
        const clippedLeft = clamp(left, HEADER_COLUMN_WIDTH, frame.width)
        const clippedTop = clamp(top, HEADER_ROW_HEIGHT, frame.height)
        const rect = visible && width > 0 && height > 0
          ? {
              height: clamp(top + height, HEADER_ROW_HEIGHT, frame.height) - clippedTop,
              left: dx + clippedLeft,
              top: dy + clippedTop,
              width: clamp(left + width, HEADER_COLUMN_WIDTH, frame.width) - clippedLeft,
            }
          : null
        const cursor = peer.cursor
          ? cellRect(model, sheet, peer.cursor.r, peer.cursor.c)
          : null
        const tag = cursor && cursor.left < frame.width && cursor.top < frame.height
          ? {
              below: cursor.top - 18 < HEADER_ROW_HEIGHT,
              left: dx + Math.max(cursor.left, HEADER_COLUMN_WIDTH),
              top: dy + (cursor.top - 18 < HEADER_ROW_HEIGHT ? cursor.top + cursor.height : cursor.top - 18),
            }
          : null
        const draftCell = peer.draft ? cellRect(model, sheet, peer.draft.r, peer.draft.c) : null
        next.push({
          clientId: peer.clientId,
          color: peer.actor.color,
          draft: peer.draft && draftCell
            ? {
                left: dx + draftCell.left,
                text: peer.draft.text,
                top: dy + draftCell.top,
                // Widened past the cell the way a real editor overflows, so a
                // long draft is readable instead of being cut at the border.
                width: Math.max(draftCell.width, 120),
              }
            : null,
          isAgent: peer.actor.type === 'agent',
          name: peer.actor.displayName,
          rect,
          tag,
        })
      }
      setPlaced(next)
    }
    measure()
    container.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      container.removeEventListener('scroll', measure)
      observer.disconnect()
    }
    // `onSheet` is rebuilt every render; `key` is its content, which is what
    // actually decides whether anything moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, container, key, model, revision, sheet])

  if (placed.length === 0 && touchHandles.length === 0) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="spreadsheet-presence-overlay"
    >
      {placed.map((peer) => (
        <div key={peer.clientId}>
          {peer.rect ? (
            <div
              className="spreadsheet-presence-cursor absolute"
              data-peer={peer.clientId}
              data-testid="spreadsheet-peer-range"
              style={{
                backgroundColor: `${peer.color}22`,
                border: `2px solid ${peer.color}`,
                height: peer.rect.height,
                left: peer.rect.left,
                top: peer.rect.top,
                width: peer.rect.width,
              }}
            />
          ) : null}
          {peer.tag ? (
            <div
              className="spreadsheet-presence-label absolute truncate rounded-sm px-1 text-[10px] leading-4 text-white"
              data-testid="spreadsheet-peer-tag"
              style={{
                backgroundColor: peer.color,
                left: peer.tag.left,
                maxWidth: 140,
                top: peer.tag.top,
              }}
            >
              {peer.isAgent ? '⌬ ' : ''}{peer.name}
            </div>
          ) : null}
          {peer.draft ? (
            <div
              className="spreadsheet-presence-draft absolute truncate px-1 text-xs leading-5"
              data-draft-for={peer.clientId}
              data-testid="spreadsheet-peer-draft"
              style={{
                backgroundColor: 'var(--panel)',
                border: `1px dashed ${peer.color}`,
                color: peer.color,
                left: peer.draft.left,
                top: peer.draft.top,
                width: peer.draft.width,
              }}
            >
              {peer.draft.text}
              {/* The caret is what says "still typing" rather than "already
                  saved" — without it a ghosted value reads as committed. */}
              <span className="spreadsheet-draft-caret" style={{ borderColor: peer.color }} />
            </div>
          ) : null}
        </div>
      ))}
      {touchHandles.map((handle) => (
        <div
          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
          data-testid={`spreadsheet-touch-handle-${handle.key}`}
          key={handle.key}
          style={{
            backgroundColor: 'var(--accent)',
            border: '2px solid var(--panel)',
            left: handle.left,
            top: handle.top,
          }}
        />
      ))}
    </div>
  )
}

/** Exported for the strip's tooltip, which names a peer's cell in A1. */
export const peerCellLabel = (peer: SpreadsheetPresenceEvent): string | null =>
  peer.cursor ? `${columnIndexToLabel(peer.cursor.c)}${peer.cursor.r}` : null
