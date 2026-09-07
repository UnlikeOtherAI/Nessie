import assert from 'node:assert/strict'
import test from 'node:test'

import { createEvent, type FetchLike } from '../src/calendar/client.js'

test('creates an event with Google Meet and preserves the returned schedule', async () => {
  let request: { body?: string; headers?: Record<string, string>; url: string } | undefined
  const fetchImpl: FetchLike = async (url, init) => {
    request = { body: init?.body, headers: init?.headers, url }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }],
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
        },
        end: { dateTime: '2026-09-15T10:30:00+01:00' },
        id: 'sales-call',
        start: { dateTime: '2026-09-15T10:00:00+01:00' },
        status: 'confirmed',
        summary: 'Prospect discovery call',
      }),
      text: async () => '',
    }
  }

  const event = await createEvent(fetchImpl, 'test-access-token', {
    addMeet: true,
    attendees: ['prospect@example.test'],
    conferenceRequestId: 'meet-request-123',
    description: 'Research findings and next steps.',
    end: '2026-09-15T10:30:00+01:00',
    start: '2026-09-15T10:00:00+01:00',
    title: 'Prospect discovery call',
  })

  assert.equal(
    request?.url,
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1',
  )
  assert.equal(request?.headers?.authorization, 'Bearer test-access-token')
  assert.deepEqual(JSON.parse(request?.body ?? ''), {
    attendees: [{ email: 'prospect@example.test' }],
    conferenceData: {
      createRequest: {
        conferenceSolutionKey: { type: 'hangoutsMeet' },
        requestId: 'meet-request-123',
      },
    },
    description: 'Research findings and next steps.',
    end: { dateTime: '2026-09-15T10:30:00+01:00' },
    start: { dateTime: '2026-09-15T10:00:00+01:00' },
    summary: 'Prospect discovery call',
  })
  assert.deepEqual(event, {
    attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }],
    allDay: false,
    end: '2026-09-15T10:30:00+01:00',
    id: 'sales-call',
    meetingUri: 'https://meet.google.com/abc-defg-hij',
    start: '2026-09-15T10:00:00+01:00',
    status: 'confirmed',
    title: 'Prospect discovery call',
  })
})
