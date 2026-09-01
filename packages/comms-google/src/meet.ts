import { safeFetch, type SafeFetchOptions } from '@nessie/runtime'

export const GOOGLE_MEET_CREATE_SCOPE =
  'https://www.googleapis.com/auth/meetings.space.created'

const GOOGLE_MEET_SPACES_URL = 'https://meet.googleapis.com/v2/spaces'

export class GoogleMeetApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`[comms-google] Meet space creation failed with status ${status}`)
    this.name = 'GoogleMeetApiError'
    this.status = status
  }
}

const readMeetingUri = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || !('meetingUri' in value)) {
    return null
  }
  const meetingUri = (value as { meetingUri: unknown }).meetingUri
  return typeof meetingUri === 'string' && meetingUri.length > 0
    ? meetingUri
    : null
}

/**
 * Create one OPEN Google Meet space under the supplied user's OAuth authority.
 * The fixed Google endpoint is still sent through `safeFetch` so the request is
 * DNS-pinned like every other credentialed outbound call. Provider bodies and
 * bearer headers are never logged or copied into errors.
 */
export const createGoogleMeetSpace = async (
  accessToken: string,
  safeFetchOptions?: SafeFetchOptions,
): Promise<string> => {
  const response = await safeFetch(
    GOOGLE_MEET_SPACES_URL,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ config: { accessType: 'OPEN' } }),
    },
    safeFetchOptions,
  )

  if (!response.ok) {
    throw new GoogleMeetApiError(response.status)
  }

  const meetingUri = readMeetingUri(await response.json())
  if (!meetingUri) {
    throw new GoogleMeetApiError(response.status)
  }
  return meetingUri
}
