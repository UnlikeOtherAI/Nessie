import type { AgentRecord } from '../../../../lib/api-client'

export const THREAD_PANEL_WIDTH_STORAGE_KEY = 'nessie.threadPanelWidth'
export const THREAD_PANEL_DEFAULT_WIDTH = 400
export const THREAD_PANEL_MIN_WIDTH = 320

// How long the panel takes to leave. The route change is held until the end so
// the panel keeps rendering its own thread on the way out — its queries are
// keyed on the open root, so navigating first would empty it mid-animation.
// `styles.css` `.thread-panel` carries the matching duration; change both.
export const THREAD_PANEL_CLOSE_MS = 220

// Drag-resize bounds for the reply-thread panel: never narrower than the
// Slack-style minimum and never wider than half the viewport.
export const clampThreadPanelWidth = (width: number, viewportWidth: number): number => {
  if (!Number.isFinite(width)) {
    return THREAD_PANEL_DEFAULT_WIDTH
  }
  const max = Math.max(THREAD_PANEL_MIN_WIDTH, Math.floor(viewportWidth / 2))
  return Math.min(Math.max(Math.round(width), THREAD_PANEL_MIN_WIDTH), max)
}

// Read the persisted panel width, tolerating missing/garbage values.
export const readThreadPanelWidth = (
  stored: string | null,
  viewportWidth: number,
): number => clampThreadPanelWidth(stored === null ? Number.NaN : Number(stored), viewportWidth)

// "Also send to #channel" copies land in the channel feed as top-level
// messages tagged with metadata.replyBroadcast = { rootMessageId }.
export const getReplyBroadcastRootId = (
  metadata: Record<string, unknown> | undefined,
): string | null => {
  const broadcast = metadata?.replyBroadcast
  if (!broadcast || typeof broadcast !== 'object' || Array.isArray(broadcast)) {
    return null
  }
  const rootMessageId = (broadcast as Record<string, unknown>).rootMessageId
  return typeof rootMessageId === 'string' && rootMessageId.length > 0 ? rootMessageId : null
}

// One avatar entry in a reply summary bar, resolved from a participant id
// against the channel's users and agents.
export type ThreadParticipant =
  | {
      kind: 'user'
      userId: string
      avatarAttachmentId?: string | null
      avatarUrl?: string | null
      displayName: string
    }
  | { kind: 'agent'; agent: AgentRecord }
