import { useState } from 'react'
import type { GoogleCapabilityId } from '../../../lib/api-client'
import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../../facades/connections/hooks'

/**
 * The in-chat permission request.
 *
 * Posted by a Google tool that hit a missing scope, from
 * `{ card: { kind: 'google_scope_request', capabilityId } }`. The capability id
 * is server-authored — it comes from the tool that failed, never from model
 * output — so this card cannot be talked into asking for something broader.
 *
 * It exists so a missing permission is recoverable in the conversation where
 * the person is standing, rather than a refusal they have to go elsewhere to
 * act on.
 */

const CAPABILITY_COPY: Record<GoogleCapabilityId, { label: string; explains: string }> = {
  'gmail.read': {
    label: 'Read your email',
    explains: 'Search and read your messages, threads, labels and attachments.',
  },
  'gmail.compose': {
    label: 'Write drafts and send email as you',
    explains:
      'Create and edit drafts, and send them as you. Google grants drafting and '
      + 'sending together; Nessie still asks before anything is sent.',
  },
  'gmail.send': {
    label: 'Send email as you',
    explains: 'Send a message directly as you. Cannot read your mail.',
  },
  'gmail.modify': {
    label: 'Organise your email',
    explains: 'Apply labels, archive, and move messages to trash.',
  },
  'calendar.read': {
    label: 'Read your calendar',
    explains: 'List your calendars and read event details.',
  },
  'calendar.freebusy': {
    label: 'See when you are free',
    explains: 'Read only your busy/free blocks — never event titles or guests.',
  },
  'calendar.write': {
    label: 'Manage calendar events',
    explains: 'Create, update and cancel events, and invite guests.',
  },
  'meet.create': {
    label: 'Create Google Meet links',
    explains: 'Create a Meet space so a call can be started for you.',
  },
  'contacts.read': {
    label: 'Look up your contacts',
    explains: 'Resolve a name you mention to an email address.',
  },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readGoogleScopeRequest = (
  metadata: Record<string, unknown> | undefined,
): GoogleCapabilityId | null => {
  const card = metadata?.card
  if (!isRecord(card) || card.kind !== 'google_scope_request') return null
  const id = card.capabilityId
  return typeof id === 'string' && id in CAPABILITY_COPY
    ? (id as GoogleCapabilityId)
    : null
}

export const GoogleScopeRequestCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const capabilityId = readGoogleScopeRequest(metadata)
  const connections = useCommsConnections()
  const start = useStartCommsConnection()
  const [error, setError] = useState<string | null>(null)

  if (!capabilityId) return null
  const copy = CAPABILITY_COPY[capabilityId]

  const google = connections.data?.connections.find(
    (entry) => entry.provider === 'google' && entry.status === 'active',
  )

  const grant = async () => {
    setError(null)
    try {
      const result = await start.mutateAsync({
        provider: 'google',
        capabilities: [capabilityId],
        // Widen the existing connection when there is one, so granting here
        // never creates a second account or narrows what is already held.
        ...(google ? { connectionId: google.id } : {}),
      })
      window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
    } catch {
      setError('Could not start the permission request. Please try again.')
    }
  }

  return (
    <div
      className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3"
      data-testid="google-scope-request-card"
    >
      <span className="text-[11px] font-semibold uppercase text-[color:var(--tx3)]">
        Permission needed
      </span>
      <div className="mt-1 text-sm font-semibold text-[color:var(--tx)]">
        {copy.label}
      </div>
      <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
        {copy.explains}
      </p>
      {error ? (
        <p className="mt-1 text-[11px] text-[color:var(--danger-text)]">{error}</p>
      ) : null}
      <div className="mt-3">
        <button
          className="admin-button admin-button-primary"
          data-testid="google-scope-grant"
          disabled={start.isPending}
          onClick={() => void grant()}
          type="button"
        >
          {start.isPending ? 'Opening…' : 'Grant'}
        </button>
      </div>
    </div>
  )
}
