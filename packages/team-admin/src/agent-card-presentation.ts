import {
  type AgentCardBlock,
  type AgentCardSpec,
  type PresentedAgentCardBlock,
} from '@nessie/schemas'

/**
 * How a card reads as plain text, in the three places one is needed.
 *
 * Shared because the worker writes the card's message content and its context
 * note while the API writes the response message, and all three describe the
 * same object; two formatters would drift the moment a block type is added.
 */

const formatValue = (value: string | number | boolean): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

const blockLines = (block: AgentCardBlock): string[] => {
  switch (block.type) {
    case 'text':
      return [block.markdown]
    case 'fields':
      return block.items.map((item) => `${item.label}: ${item.value}`)
    case 'image':
      return [block.caption ? `[image: ${block.alt} — ${block.caption}]` : `[image: ${block.alt}]`]
    case 'link':
      return [`${block.label}: ${block.href}`]
    case 'input':
    case 'secret':
      return []
    default: {
      // Exhaustiveness: a new block type must decide how it reads as text.
      const never: never = block
      return never
    }
  }
}

const inputLabels = (spec: AgentCardSpec): string[] =>
  spec.blocks.flatMap((block) =>
    block.type === 'input'
      ? [block.label]
      : block.type === 'secret'
        ? [`${block.label} (secret)`]
        : [],
  )

/**
 * The card's message content. This is what search, push previews, other
 * clients and the model's transcript window see, so it has to say everything
 * the card says apart from its interactivity.
 */
export const renderAgentCardPlainText = (spec: AgentCardSpec): string => {
  const lines: string[] = []
  lines.push(spec.service ? `${spec.service.label} — ${spec.title}` : spec.title)
  if (spec.subtitle) lines.push(spec.subtitle)

  const body = spec.blocks.flatMap(blockLines)
  if (body.length > 0) lines.push('', ...body)

  const asks = inputLabels(spec)
  if (asks.length > 0) lines.push('', `Asks for: ${asks.join(', ')}`)

  lines.push('', `Buttons: ${spec.actions.map((action) => action.label).join(', ')}`)
  return lines.join('\n')
}

/** The response message's content: what the person pressed, and what they entered. */
export const renderAgentCardResponseText = (input: {
  actionLabel: string
  values: Record<string, string | number | boolean>
  secretKeys: string[]
  spec: AgentCardSpec
}): string => {
  const labelFor = (key: string): string => {
    const block = input.spec.blocks.find(
      (candidate) =>
        (candidate.type === 'input' || candidate.type === 'secret') && candidate.key === key,
    )
    return block && (block.type === 'input' || block.type === 'secret') ? block.label : key
  }

  const parts = [
    ...Object.entries(input.values).map(
      ([key, value]) => `${labelFor(key)}: ${formatValue(value)}`,
    ),
    // A secret is reported as provided and never by value — here least of all,
    // because this string is a durable message in the conversation.
    ...input.secretKeys.map((key) => `${labelFor(key)}: provided`),
  ]

  return parts.length > 0 ? `${input.actionLabel} · ${parts.join(' · ')}` : input.actionLabel
}

export type AgentCardNoteState = {
  spec: AgentCardSpec
  status: 'open' | 'resolved' | 'expired' | 'cancelled'
  expiresAt: Date | null
  resolvedActionKey: string | null
  resolvedAtLabel: string | null
  resolvedByName: string | null
  resolutionValues: Record<string, string | number | boolean>
  secretKeys: string[]
  waitingForNames: string[]
}

/**
 * The line joined beside a card message's content in the model's context —
 * exactly where the attachment inventory line goes. Computed at render time
 * from the row, so a resolved card reads as resolved in every later run
 * without anybody rewriting the message.
 */
export const buildAgentCardStateNote = (state: AgentCardNoteState): string => {
  const buttons = state.spec.actions.map((action) => action.label).join(', ')
  const parts = [`card "${state.spec.title}"`, `buttons: ${buttons}`]

  if (state.status === 'open') {
    parts.push(
      state.waitingForNames.length > 0
        ? `open, waiting for ${state.waitingForNames.join(', ')}`
        : 'open, nobody has pressed yet',
    )
    if (state.expiresAt) parts.push(`expires ${state.expiresAt.toISOString()}`)
  } else if (state.status === 'resolved') {
    const action = state.spec.actions.find((candidate) => candidate.key === state.resolvedActionKey)
    const who = state.resolvedByName ?? 'someone'
    const when = state.resolvedAtLabel ? ` ${state.resolvedAtLabel}` : ''
    parts.push(`resolved: ${action?.label ?? state.resolvedActionKey ?? 'answered'} by ${who}${when}`)
    for (const [key, value] of Object.entries(state.resolutionValues)) {
      parts.push(`${key}=${formatValue(value)}`)
    }
    for (const key of state.secretKeys) parts.push(`secret "${key}": provided`)
  } else {
    parts.push(state.status)
  }

  return `[${parts.join(' · ')}]`
}

/**
 * Strip a spec down to what a client may see: a secret block's destination is
 * an instance id, which is not the viewer's business — they only need to know
 * the field is a secret and roughly where it goes.
 */
export const presentAgentCardBlocks = (
  spec: AgentCardSpec,
  secretDestinationLabels: Record<string, string>,
): PresentedAgentCardBlock[] =>
  spec.blocks.map((block) =>
    block.type === 'secret'
      ? {
          type: 'secret' as const,
          key: block.key,
          label: block.label,
          ...(block.help === undefined ? {} : { help: block.help }),
          destinationLabel: secretDestinationLabels[block.key] ?? 'the encrypted credential store',
        }
      : block,
  )
