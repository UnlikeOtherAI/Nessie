import { z } from 'zod'

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
  projectId: NonEmptyStringSchema.max(200),
})

export const CloudBrowserConnectionSchema = z.object({
  id: z.string().uuid(),
  scope: CloudBrowserScopeSchema,
  projectId: z.string(),
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
  liveViewUrl: z.string().url().nullable(),
  tabs: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    liveViewUrl: z.string().url(),
  })),
})

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
  tabs: z.array(AgentBrowserTabSchema),
})

export const ResumeAgentBrowserResponseSchema = z.object({
  sessionId: z.string().uuid(),
  restoredTabs: z.number().int().min(0),
})

export type AgentBrowserTab = z.infer<typeof AgentBrowserTabSchema>
export type AgentBrowserTabsResponse = z.infer<typeof AgentBrowserTabsResponseSchema>
export type BrowserLoginList = z.infer<typeof BrowserLoginListSchema>
