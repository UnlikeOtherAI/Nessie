import { z } from 'zod'
import { BrowserViewportSchema } from '@nessie/schemas'

import { NonEmptyStringSchema } from './shared.js'

/**
 * Cloud browser connections and sessions.
 *
 * The API key appears in exactly one place — the connect body — and never in
 * a response: it plus a context id is session-equivalent material, so the
 * store keeps it and callers only ever see a server-minted reference they
 * cannot use.
 */

export const CloudBrowserScopeSchema = z.enum(['organization', 'team', 'user'])

export const ConnectCloudBrowserBodySchema = z.object({
  scope: CloudBrowserScopeSchema,
  /** Required at team scope, refused at the others. */
  teamId: z.string().uuid().optional(),
  apiKey: NonEmptyStringSchema.max(500),
  /**
   * Not asked for by any Nessie surface — Browserbase resolves the project
   * from the key. Still accepted, so an install that wants its sessions
   * pinned to one project can say so, and so an older client that still
   * sends one is not rejected.
   */
  projectId: NonEmptyStringSchema.max(200).optional(),
})

export const CloudBrowserConnectionSchema = z.object({
  id: z.string().uuid(),
  scope: CloudBrowserScopeSchema,
  /** Null on every connection made since the project id stopped being asked for. */
  projectId: z.string().nullable(),
  status: z.enum(['active', 'needs_attention', 'disabled']),
  healthReason: z.string().nullable(),
  healthDetail: z.string().nullable(),
  createdAt: z.string(),
  liveSessions: z.number().int().min(0),
  usedMinutes: z.number().int().min(0),
  /** True when this row is the caller's own personal connection. */
  isMine: z.boolean(),
})

export const CloudBrowserConnectionListSchema = z.object({
  connections: z.array(CloudBrowserConnectionSchema),
})

export const CloudBrowserSessionSummarySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  /** Null for a session a person resumed from the conversation. */
  runId: z.string().uuid().nullable(),
  status: z.enum(['allocating', 'active', 'releasing', 'released', 'failed', 'unknown']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Whether a person currently holds the controls, and who. */
  controlledByUserId: z.string().uuid().nullable(),
})

export const CloudBrowserSessionListSchema = z.object({
  sessions: z.array(CloudBrowserSessionSummarySchema),
})

/**
 * The live view URL is minted per read and never persisted, logged, or put in
 * a message: whoever holds it can drive the browser for as long as the
 * session lives.
 */
export const CloudBrowserSessionDetailSchema = CloudBrowserSessionSummarySchema.extend({
  /** The server's current authority for this viewer, rechecked on every read. */
  viewerMode: z.enum(['controller', 'observer']),
  /** False once the displayed holder's heartbeat expires, so it can be reclaimed. */
  controlLeaseActive: z.boolean(),
  /** Only an owner's exact private home can relay human browser input. */
  canControl: z.boolean(),
  /**
   * Whether anything signed in through this session is shared with other
   * people. True only for a durable browser with no principal — a team
   * agent's one jar. A per-person browser (every system-managed agent's, so
   * the Personal Assistant's) and a throwaway session are both false, and the
   * viewer must not tell their driver otherwise.
   */
  shared: z.boolean(),
  /**
   * The window this session is running in. Browserbase fixes it at session
   * creation, so this is what the browser *is*, not what the agent's browser
   * is set to — the two differ for exactly as long as it takes a resize to
   * reach a session that was already open.
   */
  viewport: BrowserViewportSchema,
  /**
   * When the idle window closes. The countdown reads this rather than running
   * a timer of its own: a reload would restart a local timer and go on showing
   * time remaining on a session the reaper had already taken.
   */
  expiresAt: z.string(),
  /**
   * Kept as a null compatibility field while clients move to the mediated
   * screenshot stream. A Browserbase live-view URL is an input capability and
   * must never leave the API.
   */
  liveViewUrl: z.null(),
  /** Present only to the owner of a still-active one-time login grant. */
  privateAccess: z.object({ grantId: z.string().uuid(), expiresAt: z.string() }).nullable(),
  tabs: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
  })),
})

/** One private, transient frame from the server-side CDP connection. */
export const CloudBrowserSessionScreenshotSchema = z.object({
  imageDataUrl: z.string().startsWith('data:image/png;base64,').nullable(),
})

const HumanBrowserKeySchema = z.enum([
  'Alt', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Backspace',
  'Delete', 'End', 'Enter', 'Escape', 'Home', 'PageDown', 'PageUp', 'Space', 'Tab',
])

/**
 * Closed human-only input grammar. It is intentionally separate from the
 * agent tool grammar: browser agents act on observed semantic nodes, while a
 * person operates the remote canvas at viewport coordinates.
 */
export const HumanBrowserInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('navigate'),
    url: z.string().url().max(2_048).refine((url) => new URL(url).protocol === 'https:', {
      message: 'Only HTTPS addresses are allowed.',
    }),
  }).strict(),
  z.object({ type: z.literal('back') }).strict(),
  z.object({ type: z.literal('forward') }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('switch_tab'), targetId: z.string().min(1).max(200) }).strict(),
  z.object({
    type: z.literal('click'),
    x: z.number().finite().min(0).max(20_000),
    y: z.number().finite().min(0).max(20_000),
  }).strict(),
  z.object({
    type: z.literal('scroll'),
    x: z.number().finite().min(0).max(20_000),
    y: z.number().finite().min(0).max(20_000),
    deltaX: z.number().finite().min(-20_000).max(20_000),
    deltaY: z.number().finite().min(-20_000).max(20_000),
  }).strict(),
  z.object({ type: z.literal('key'), key: HumanBrowserKeySchema }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(10_000) }).strict(),
])

export type HumanBrowserInput = z.infer<typeof HumanBrowserInputSchema>

export type ConnectCloudBrowserBody = z.infer<typeof ConnectCloudBrowserBodySchema>
export type CloudBrowserConnectionRecord = z.infer<typeof CloudBrowserConnectionSchema>
export type CloudBrowserSessionSummary = z.infer<typeof CloudBrowserSessionSummarySchema>
export type CloudBrowserSessionDetail = z.infer<typeof CloudBrowserSessionDetailSchema>

export const AgentBrowserLoginSchema = z.object({
  id: z.string().uuid(),
  serviceHint: z.string(),
  createdAt: z.string(),
  signedInByUserId: z.string().uuid(),
  signedInByName: z.string().nullable(),
})

export const AgentBrowserResponseSchema = z.object({
  browser: z.object({
    id: z.string().uuid(),
    connectionScope: CloudBrowserScopeSchema,
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    inUse: z.boolean(),
    /** A legacy shared jar that contains a human sign-in is reset-only. */
    loginStatus: z.enum(['unsigned', 'personal', 'legacy_team_human']),
    logins: z.array(AgentBrowserLoginSchema),
  }).nullable(),
})

export const BrowserLoginListSchema = z.object({
  logins: z.array(z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    agentName: z.string(),
    serviceHint: z.string(),
    createdAt: z.string(),
  })),
})

export type AgentBrowserResponse = z.infer<typeof AgentBrowserResponseSchema>

/**
 * The tabs an agent's browser was last seen with. The screenshot travels
 * inline as a data URL: it is thumbnail-sized by construction, and one
 * authenticated read is simpler than a second image fetch per tab.
 */
export const AgentBrowserTabSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().min(0),
  url: z.string(),
  title: z.string(),
  capturedAt: z.string().nullable(),
  screenshotDataUrl: z.string().nullable(),
})

export const AgentBrowserTabsResponseSchema = z.object({
  /** False when the agent has no durable browser yet — no tabs is then expected. */
  hasBrowser: z.boolean(),
  /** Page material is unavailable until an unsafe legacy team jar is reset. */
  quarantined: z.boolean(),
  tabs: z.array(AgentBrowserTabSchema),
})

export const ResumeAgentBrowserResponseSchema = z.object({
  sessionId: z.string().uuid(),
  restoredTabs: z.number().int().min(0),
})

export type AgentBrowserTab = z.infer<typeof AgentBrowserTabSchema>
export type AgentBrowserTabsResponse = z.infer<typeof AgentBrowserTabsResponseSchema>
export type BrowserLoginList = z.infer<typeof BrowserLoginListSchema>


/**
 * Resizing an agent's browser. The pair is remembered on the browser, so the
 * next session it opens — the agent's own, not only this person's — comes back
 * the same size.
 */
export const SetAgentBrowserViewportBodySchema = BrowserViewportSchema

/** A one-time private session has no durable browser whose preference it can change. */
export const SetCloudBrowserSessionViewportBodySchema = BrowserViewportSchema

export const ActivatePersonalBrowserAccessGrantBodySchema = z.object({
  viewport: BrowserViewportSchema.optional(),
}).strict()

export const AgentBrowserViewportResponseSchema = z.object({
  viewport: BrowserViewportSchema,
  /**
   * Whether the session on screen was resized too. False is ordinary rather
   * than a failure: nothing was open, or the provider would not resize a live
   * window, and either way the size is stored and the next session honours it.
   */
  appliedToLiveSession: z.boolean(),
})

export const CloudBrowserSessionViewportResponseSchema = z.object({
  viewport: BrowserViewportSchema,
})

export const BrowserHomeResponseSchema = z.object({
  /** Where it was sent, so the caller can say so without resolving it again. */
  url: z.string().url(),
})

export type SetAgentBrowserViewportBody = z.infer<typeof SetAgentBrowserViewportBodySchema>
export type SetCloudBrowserSessionViewportBody = z.infer<typeof SetCloudBrowserSessionViewportBodySchema>


/** What a press of Continue answers with, so the countdown can reset. */
export const BrowserSessionContinueResponseSchema = z.object({
  expiresAt: z.string(),
})
