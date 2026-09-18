import type { AgentAccessScope } from '../../../facades/agent-access/hooks'
import type { PillTone } from '../../primitives/Pill'

/**
 * One reading of a paired agent's scopes and lifecycle, shared by the personal
 * list, the organisation governance list and the credential's own screen. The
 * three spelled the same facts three ways — "read boards" here, "Read boards"
 * there, and a hand-rolled active/expired/revoked ternary in each.
 */

export const SCOPE_COPY: Record<AgentAccessScope, { detail: string; label: string }> = {
  boards_read: {
    detail: 'See your boards and the tasks on them, including boards mirrored from Linear.',
    label: 'Read boards',
  },
  boards_write: {
    detail: 'Create tasks, edit them, and move them between columns.',
    label: 'Change boards',
  },
  documents_read: {
    detail: 'Read the knowledge spaces and documents you can read.',
    label: 'Read documents',
  },
  documents_write: {
    detail:
      'Create and edit documents as drafts. Publishing one still comes to you as '
      + 'an approval — an agent can ask, but it cannot publish.',
    label: 'Write documents as drafts',
  },
}

export const SCOPE_ORDER: AgentAccessScope[] = [
  'boards_read',
  'boards_write',
  'documents_read',
  'documents_write',
]

export type CredentialLifecycle = 'active' | 'expired' | 'revoked'

/** Whether a credential is still lending an account out, and why not if not. */
export const credentialLifecycle = (credential: {
  expiresAt: string
  revokedAt: string | null
}): CredentialLifecycle => {
  if (credential.revokedAt !== null) return 'revoked'
  return new Date(credential.expiresAt).getTime() <= Date.now() ? 'expired' : 'active'
}

export const credentialTone = (lifecycle: CredentialLifecycle): PillTone =>
  lifecycle === 'active' ? 'success' : 'muted'

export const formatCredentialDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

export const formatLastUsed = (value: string | null): string => {
  if (!value) return 'never used'
  const elapsed = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'used just now'
  if (minutes < 60) return `used ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `used ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `used ${days} day${days === 1 ? '' : 's'} ago`
  return `last used ${formatCredentialDate(value)}`
}

/** What a credential's scopes amount to, in a phrase rather than a list. */
export const describeScopes = (scopes: AgentAccessScope[]): string => {
  if (scopes.length === 0) return 'Nothing granted'
  const boards = scopes.includes('boards_write')
    ? 'read and change boards'
    : scopes.includes('boards_read')
      ? 'read boards'
      : null
  const documents = scopes.includes('documents_write')
    ? 'draft documents'
    : scopes.includes('documents_read')
      ? 'read documents'
      : null
  const sentence = [boards, documents].filter((part): part is string => part !== null).join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
