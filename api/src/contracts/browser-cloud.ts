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

export const CloudBrowserScopeSchema = z.enum(['organization', 'user'])

export const ConnectCloudBrowserBodySchema = z.object({
  scope: CloudBrowserScopeSchema,
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
  runId: z.string().uuid(),
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
