import type { GoogleCapabilityId } from '../../../lib/api-client'

export const GOOGLE_WORKSPACE_CAPABILITIES: ReadonlyArray<{
  description: string
  id: GoogleCapabilityId
  label: string
}> = [
  { description: 'List calendars and read event details.', id: 'calendar.read', label: 'Read calendar events' },
  { description: 'See busy and free time without event titles or guests.', id: 'calendar.freebusy', label: 'See availability' },
  { description: 'Create, update and cancel events, including invitations.', id: 'calendar.write', label: 'Manage calendar events' },
  { description: 'Create a standalone Google Meet space for a call.', id: 'meet.create', label: 'Create Google Meet links' },
]

export const googleWorkspaceStartInput = (capabilities: readonly GoogleCapabilityId[]) => ({
  capabilities: [...capabilities],
  provider: 'google' as const,
})
