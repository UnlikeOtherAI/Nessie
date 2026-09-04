import type { AgentVisibility } from '@nessie/schemas'

import type { AgentRecord, UserRecord } from './api-client'

/**
 * The "New message" address book.
 *
 * The Direct-messages list is a list of *conversations* — a row appears once
 * its channel carries a message. The address book is the opposite question:
 * everything you can start a conversation with. That includes the app's own
 * agents, which the conversations list has no row for until you have written
 * to them, and which the default agent list omits entirely because it excludes
 * every `systemManaged` row.
 *
 * Selection is structural, never a name or a hand-written slug:
 * `AgentRecord.dmAddressable` is the server's own answer to "does addressing
 * this agent resolve to a home DM", the same predicate
 * `POST /api/channels/conversations` branches on. So the picker offers exactly
 * what the route accepts.
 */

export type RecipientKind = 'agent' | 'user'

export type Recipient = {
  id: string
  kind: RecipientKind
}

export type RecipientOption = Recipient & {
  agentVisibility?: AgentVisibility
  category: 'person' | 'private agent' | 'team agent'
  detail: string
  label: string
  user?: UserRecord
}

export const recipientKey = (recipient: Recipient): string =>
  `${recipient.kind}:${recipient.id}`

export const matchesRecipientQuery = (
  option: RecipientOption,
  query: string,
): boolean => {
  const term = query.trim().toLowerCase()
  if (!term) {
    return true
  }
  return `${option.label} ${option.detail} ${option.category}`.toLowerCase().includes(term)
}

/**
 * The agents a person may address.
 *
 * A DM-homed system agent is addressable by everybody: opening your own home DM
 * is not placement, so it carries no owner gate on the server either. Ordinary
 * agents keep the gate this picker has always applied — `POST
 * /api/channels/conversations` refuses to bind one for a non-owner, and
 * offering an option that always fails would be worse than omitting it.
 */
export const selectAddressableAgents = (
  agents: AgentRecord[],
  options: { isOwner: boolean },
): AgentRecord[] =>
  agents.filter((agent) =>
    (agent.dmAddressable === true)
    || (options.isOwner && agent.systemManaged !== true))

export const buildRecipientOptions = (input: {
  agents: AgentRecord[]
  limit: number
  query: string
  selectedKeys: Set<string>
  users: UserRecord[]
}): RecipientOption[] => {
  const userOptions: RecipientOption[] = input.users.map((user) => ({
    category: 'person',
    detail: user.email,
    id: user.id,
    kind: 'user',
    label: user.displayName,
    user,
  }))
  const agentOptions: RecipientOption[] = input.agents.map((agent) => ({
    agentVisibility: agent.visibility,
    category: agent.visibility === 'private' ? 'private agent' : 'team agent',
    detail: agent.role,
    id: agent.id,
    kind: 'agent',
    label: agent.name,
  }))

  return [...userOptions, ...agentOptions]
    .filter((option) => !input.selectedKeys.has(recipientKey(option)))
    .filter((option) => matchesRecipientQuery(option, input.query))
    .slice(0, input.limit)
}
