import { randomUUID } from 'node:crypto'

import { getGoogleCapability, type GoogleCapabilityId } from '@nessie/schemas'
import {
  createEvent,
  deleteEvent,
  listCalendars,
  listEvents,
  patchEvent,
  queryFreeBusy,
} from '@nessie/comms-google'
import { loadUserGoogleCommsCredential } from '@nessie/workspace-admin'
import { safeFetch } from '@nessie/runtime'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  explainGoogleFailure,
  recordGoogleRead,
  resolveGoogleActingUserId,
} from './google-access.js'

const calendarFetch = async (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => {
  const response = await safeFetch(url, init ?? {})
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  }
}

const encryptionSecret = (): string => {
  const secret = process.env.NESSIE_AUTH_SECRET
  if (!secret) throw new Error('NESSIE_AUTH_SECRET is not configured')
  return secret
}

const credentialFor = async (
  context: BuiltinToolRuntimeContext,
  capabilityId: GoogleCapabilityId,
  userId: string,
) => {
  try {
    return await loadUserGoogleCommsCredential(context.prisma, {
      organizationId: context.channel.organizationId,
      userId,
      requiredScopes: getGoogleCapability(capabilityId).scopes,
      capabilityId,
      encryptionSecret: encryptionSecret(),
    })
  } catch (error) {
    return explainGoogleFailure(context, capabilityId, userId, {
      code: (error as { code?: string }).code,
      ...(error as object),
    } as never)
  }
}

const EventsListSchema = z.object({
  calendarId: z.string().optional(),
  timeMin: z.string().optional(),
  timeMax: z.string().optional(),
  query: z.string().max(300).optional(),
}).strict()

const FreeBusySchema = z.object({
  timeMin: z.string(),
  timeMax: z.string(),
  attendees: z.array(z.string()).max(30).optional(),
}).strict()

const EventCreateSchema = z.object({
  calendarId: z.string().optional(),
  title: z.string().min(1).max(500),
  start: z.string(),
  end: z.string(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string()).max(100).optional(),
  addMeet: z.boolean().optional(),
}).strict()

const EventUpdateSchema = z.object({
  calendarId: z.string().optional(),
  eventId: z.string().min(1),
  title: z.string().max(500).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string()).max(100).optional(),
}).strict()

const EventCancelSchema = z.object({
  calendarId: z.string().optional(),
  eventId: z.string().min(1),
}).strict()

export const runCalendarListTool = async (
  context: BuiltinToolRuntimeContext,
  _input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const calendars = await listCalendars(
    calendarFetch,
    credential.credential.accessToken,
  )
  return {
    inputSummary: '',
    outputPreview: JSON.stringify(calendars),
    toolName: 'calendar_list',
  }
}

export const runCalendarEventsListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = EventsListSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const events = await listEvents(
    calendarFetch,
    credential.credential.accessToken,
    args,
  )
  return {
    inputSummary: `${args.timeMin ?? 'now'}..${args.timeMax ?? ''}`,
    outputPreview: JSON.stringify(events),
    toolName: 'calendar_events_list',
  }
}

/**
 * Availability.
 *
 * This still stamps the owner's basis. It is tempting to widen free/busy to the
 * organisation on the grounds that Workspace publishes it domain-wide, but a
 * Nessie organisation is not proof of a shared Google domain, so the entitlement
 * does not translate. Times only ever leave here — no titles, guests or notes.
 */
export const runCalendarFreeBusyTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = FreeBusySchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.freebusy', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const blocks = await queryFreeBusy(
    calendarFetch,
    credential.credential.accessToken,
    {
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      emails: [credential.externalUserId, ...(args.attendees ?? [])],
    },
  )
  return {
    inputSummary: `${args.timeMin}..${args.timeMax}`,
    outputPreview: JSON.stringify(blocks),
    toolName: 'calendar_freebusy',
  }
}

export const runCalendarEventCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = EventCreateSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.write', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const event = await createEvent(
    calendarFetch,
    credential.credential.accessToken,
    {
      ...args,
      // Fresh per attempt: Google keys the async conference creation on it, and
      // reusing one would return the previous conference instead of a new link.
      ...(args.addMeet ? { conferenceRequestId: randomUUID() } : {}),
      // No attendees means nothing to notify; asking Google to mail nobody
      // saves a pointless notification round trip.
      sendUpdates: (args.attendees ?? []).length > 0 ? 'all' : 'none',
    },
  )
  return {
    inputSummary: `${args.title} ${args.start}`,
    outputPreview: JSON.stringify({
      ...event,
      // The conference is created asynchronously: Google answers `pending` and
      // the link appears on a later read, so a missing uri here is not failure.
      meetNote: args.addMeet && !event.meetingUri
        ? 'The Meet link is still being created; it will appear on the event shortly.'
        : undefined,
    }),
    toolName: 'calendar_event_create',
  }
}

export const runCalendarEventUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = EventUpdateSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.write', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const event = await patchEvent(
    calendarFetch,
    credential.credential.accessToken,
    args,
  )
  return {
    inputSummary: `eventId=${args.eventId}`,
    outputPreview: JSON.stringify(event),
    toolName: 'calendar_event_update',
  }
}

export const runCalendarEventCancelTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = EventCancelSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.write', userId)
  recordGoogleRead(context, credential.ownerUserId)
  await deleteEvent(calendarFetch, credential.credential.accessToken, args)
  return {
    inputSummary: `eventId=${args.eventId}`,
    outputPreview: JSON.stringify({ cancelled: true, eventId: args.eventId }),
    toolName: 'calendar_event_cancel',
  }
}
