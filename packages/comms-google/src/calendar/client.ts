import {
  requestJson,
  encodeForm,
  CALENDAR_API_BASE,
  type FetchLike,
} from '../http.js'

const auth = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
})

const authJson = (accessToken: string): Record<string, string> => ({
  ...auth(accessToken),
  'content-type': 'application/json',
})

export type CalendarSummary = {
  id: string
  summary: string
  primary: boolean
  accessRole: string
}

export const listCalendars = async (
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<CalendarSummary[]> => {
  const { body } = await requestJson(
    fetchImpl,
    'calendarList.list',
    `${CALENDAR_API_BASE}/users/me/calendarList`,
    { headers: auth(accessToken) },
  )
  const items = (body as { items?: unknown[] }).items ?? []
  return items.flatMap((raw) => {
    const item = raw as {
      id?: unknown
      summary?: unknown
      primary?: unknown
      accessRole?: unknown
    }
    if (typeof item?.id !== 'string') return []
    return [{
      id: item.id,
      summary: typeof item.summary === 'string' ? item.summary : item.id,
      primary: item.primary === true,
      accessRole: typeof item.accessRole === 'string' ? item.accessRole : 'reader',
    }]
  })
}

export type CalendarEvent = {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  attendees: { email: string; responseStatus: string }[]
  meetingUri?: string
  organizerEmail?: string
  status: string
}

type RawEvent = {
  id?: unknown
  summary?: unknown
  location?: unknown
  description?: unknown
  status?: unknown
  hangoutLink?: unknown
  start?: { dateTime?: unknown; date?: unknown }
  end?: { dateTime?: unknown; date?: unknown }
  organizer?: { email?: unknown }
  attendees?: { email?: unknown; responseStatus?: unknown }[]
  conferenceData?: { entryPoints?: { uri?: unknown; entryPointType?: unknown }[] }
}

const readTime = (slot: { dateTime?: unknown; date?: unknown } | undefined): {
  value: string
  allDay: boolean
} => {
  if (typeof slot?.dateTime === 'string') {
    return { value: slot.dateTime, allDay: false }
  }
  if (typeof slot?.date === 'string') {
    return { value: slot.date, allDay: true }
  }
  return { value: '', allDay: false }
}

const readMeetingUri = (event: RawEvent): string | undefined => {
  if (typeof event.hangoutLink === 'string' && event.hangoutLink.length > 0) {
    return event.hangoutLink
  }
  for (const entry of event.conferenceData?.entryPoints ?? []) {
    if (entry?.entryPointType === 'video' && typeof entry.uri === 'string') {
      return entry.uri
    }
  }
  return undefined
}

const toEvent = (raw: unknown): CalendarEvent[] => {
  const event = raw as RawEvent
  if (typeof event?.id !== 'string') return []
  const start = readTime(event.start)
  const end = readTime(event.end)
  const meetingUri = readMeetingUri(event)
  return [{
    id: event.id,
    title: typeof event.summary === 'string' ? event.summary : '(no title)',
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    ...(typeof event.location === 'string' ? { location: event.location } : {}),
    ...(typeof event.description === 'string'
      ? { description: event.description }
      : {}),
    attendees: (event.attendees ?? []).flatMap((attendee) =>
      typeof attendee?.email === 'string'
        ? [{
            email: attendee.email,
            responseStatus:
              typeof attendee.responseStatus === 'string'
                ? attendee.responseStatus
                : 'needsAction',
          }]
        : [],
    ),
    ...(meetingUri ? { meetingUri } : {}),
    ...(typeof event.organizer?.email === 'string'
      ? { organizerEmail: event.organizer.email }
      : {}),
    status: typeof event.status === 'string' ? event.status : 'confirmed',
  }]
}

export const listEvents = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: {
    calendarId?: string
    timeMin?: string
    timeMax?: string
    query?: string
    maxResults?: number
  },
): Promise<CalendarEvent[]> => {
  const params: Record<string, string> = {
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.min(Math.max(input.maxResults ?? 25, 1), 100)),
  }
  if (input.timeMin) params.timeMin = input.timeMin
  if (input.timeMax) params.timeMax = input.timeMax
  if (input.query) params.q = input.query
  const calendarId = input.calendarId ?? 'primary'
  const { body } = await requestJson(
    fetchImpl,
    'events.list',
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`
      + `?${encodeForm(params)}`,
    { headers: auth(accessToken) },
  )
  return ((body as { items?: unknown[] }).items ?? []).flatMap(toEvent)
}

export type BusyBlock = { email: string; start: string; end: string }

/**
 * Free/busy for the caller and optionally other people. Returns times only —
 * never titles, guests or notes — which is why it has its own narrow scope
 * rather than riding on calendar read.
 */
export const queryFreeBusy = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { timeMin: string; timeMax: string; emails: string[] },
): Promise<BusyBlock[]> => {
  const { body } = await requestJson(
    fetchImpl,
    'freeBusy.query',
    `${CALENDAR_API_BASE}/freeBusy`,
    {
      method: 'POST',
      headers: authJson(accessToken),
      body: JSON.stringify({
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: input.emails.map((email) => ({ id: email })),
      }),
    },
  )
  const calendars = (body as {
    calendars?: Record<string, { busy?: { start?: unknown; end?: unknown }[] }>
  }).calendars ?? {}
  const blocks: BusyBlock[] = []
  for (const [email, entry] of Object.entries(calendars)) {
    for (const slot of entry?.busy ?? []) {
      if (typeof slot?.start === 'string' && typeof slot.end === 'string') {
        blocks.push({ email, start: slot.start, end: slot.end })
      }
    }
  }
  return blocks
}

export type CreateEventInput = {
  calendarId?: string
  title: string
  start: string
  end: string
  description?: string
  location?: string
  attendees?: string[]
  /** Attach a Google Meet link to the event itself. */
  addMeet?: boolean
  /** Google's async conference request id; must be unique per attempt. */
  conferenceRequestId?: string
  /** 'all' emails the guests, 'none' does not. */
  sendUpdates?: 'all' | 'externalOnly' | 'none'
}

const eventBody = (input: CreateEventInput): Record<string, unknown> => ({
  summary: input.title,
  start: { dateTime: input.start },
  end: { dateTime: input.end },
  ...(input.description ? { description: input.description } : {}),
  ...(input.location ? { location: input.location } : {}),
  ...(input.attendees && input.attendees.length > 0
    ? { attendees: input.attendees.map((email) => ({ email })) }
    : {}),
  ...(input.addMeet && input.conferenceRequestId
    ? {
        conferenceData: {
          createRequest: {
            requestId: input.conferenceRequestId,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }
    : {}),
})

/**
 * Create an event, optionally with a Meet link.
 *
 * `conferenceDataVersion=1` is required or Google silently drops the
 * conference request. Google answers immediately with the conference in
 * `pending`; the link appears on a subsequent read, so callers must not treat a
 * missing `meetingUri` in this response as a failure.
 */
export const createEvent = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: CreateEventInput,
): Promise<CalendarEvent> => {
  const params: Record<string, string> = {
    sendUpdates: input.sendUpdates ?? 'all',
  }
  if (input.addMeet) params.conferenceDataVersion = '1'
  const calendarId = input.calendarId ?? 'primary'
  const { body } = await requestJson(
    fetchImpl,
    'events.insert',
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`
      + `?${encodeForm(params)}`,
    {
      method: 'POST',
      headers: authJson(accessToken),
      body: JSON.stringify(eventBody(input)),
    },
  )
  const [event] = toEvent(body)
  if (!event) throw new Error('[comms-google] Calendar returned no event')
  return event
}

export const patchEvent = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: Partial<CreateEventInput> & { eventId: string },
): Promise<CalendarEvent> => {
  const calendarId = input.calendarId ?? 'primary'
  const patch: Record<string, unknown> = {}
  if (input.title !== undefined) patch.summary = input.title
  if (input.start !== undefined) patch.start = { dateTime: input.start }
  if (input.end !== undefined) patch.end = { dateTime: input.end }
  if (input.description !== undefined) patch.description = input.description
  if (input.location !== undefined) patch.location = input.location
  if (input.attendees !== undefined) {
    patch.attendees = input.attendees.map((email) => ({ email }))
  }
  const { body } = await requestJson(
    fetchImpl,
    'events.patch',
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}`
      + `/events/${encodeURIComponent(input.eventId)}`
      + `?${encodeForm({ sendUpdates: input.sendUpdates ?? 'all' })}`,
    {
      method: 'PATCH',
      headers: authJson(accessToken),
      body: JSON.stringify(patch),
    },
  )
  const [event] = toEvent(body)
  if (!event) throw new Error('[comms-google] Calendar returned no event')
  return event
}

export const deleteEvent = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { calendarId?: string; eventId: string; sendUpdates?: 'all' | 'none' },
): Promise<void> => {
  const calendarId = input.calendarId ?? 'primary'
  await requestJson(
    fetchImpl,
    'events.delete',
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}`
      + `/events/${encodeURIComponent(input.eventId)}`
      + `?${encodeForm({ sendUpdates: input.sendUpdates ?? 'all' })}`,
    { method: 'DELETE', headers: auth(accessToken), notFoundOk: true },
  )
}

/**
 * Respond to an invitation on somebody else's event.
 *
 * Distinct from `patchEvent`: you are changing only your own attendee row, and
 * Calendar rejects a patch that tries to edit an event you do not own. Most of
 * what lands in a calendar is an invitation, so without this the tools can
 * manage your own events and do nothing about everyone else's.
 */
export const respondToEvent = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: {
    calendarId?: string
    eventId: string
    response: 'accepted' | 'declined' | 'tentative'
    selfEmail: string
    comment?: string
  },
): Promise<CalendarEvent> => {
  const calendarId = input.calendarId ?? 'primary'
  const path = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}`
    + `/events/${encodeURIComponent(input.eventId)}`
  const { body: current } = await requestJson(
    fetchImpl,
    'events.get',
    path,
    { headers: auth(accessToken) },
  )
  const existing = (current as RawEvent).attendees ?? []
  const self = existing.find(
    (attendee) =>
      typeof attendee?.email === 'string'
      && attendee.email.toLowerCase() === input.selfEmail.toLowerCase(),
  )
  if (!self) {
    throw new Error('[comms-google] you are not an attendee of that event')
  }
  // Send back the whole attendee list with only our row changed: Calendar
  // replaces the array wholesale, so patching with just ourselves would drop
  // everybody else's responses.
  const attendees = existing.map((attendee) =>
    attendee === self
      ? {
          email: input.selfEmail,
          responseStatus: input.response,
          ...(input.comment ? { comment: input.comment } : {}),
        }
      : attendee,
  )
  const { body } = await requestJson(
    fetchImpl,
    'events.patch',
    `${path}?${encodeForm({ sendUpdates: 'all' })}`,
    {
      method: 'PATCH',
      headers: authJson(accessToken),
      body: JSON.stringify({ attendees }),
    },
  )
  const [event] = toEvent(body)
  if (!event) throw new Error('[comms-google] Calendar returned no event')
  return event
}
