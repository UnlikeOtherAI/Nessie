// Mailbox routing.
//
// Decided from STRUCTURAL facts only — which tools the toolset actually
// assembled — in the same shape as `research-routing.ts`. Nothing here reads
// message content: whether the person wants their inbox triaged, and how
// broadly, is the model's judgement from the conversation it can see.

export type MailboxRoutingFacts = {
  hasMailboxTools: boolean
  hasCalendarTools: boolean
  hasDelegate: boolean
}

const DELEGATE_LINE =
  '- A mailbox is bigger than a turn. When a search or a thread comes back'
  + ' trimmed, do not narrow the query just to see the rest and do not page'
  + ' through it here — delegate the reading to a sub-agent and work from the'
  + ' digest it returns. One sub-agent per question, not per message.'

const SELF_LINE =
  '- Read narrowly. Ask for the smallest set of messages that answers the'
  + ' question, rather than pulling a mailbox in and sorting it here.'

/**
 * At most one block, appended to the system prompt. Absent entirely for an
 * agent with no mailbox or calendar tools, so an ordinary agent's prompt is
 * byte-identical to before.
 */
export const buildMailboxRoutingBlock = (
  facts: MailboxRoutingFacts,
): string | null => {
  if (!facts.hasMailboxTools && !facts.hasCalendarTools) return null

  const lines = ['Mailbox and calendar:']
  if (facts.hasMailboxTools) {
    lines.push(facts.hasDelegate ? DELEGATE_LINE : SELF_LINE)
    lines.push(
      '- Email you read belongs to the person who asked. Answer them with it;'
        + ' do not repeat its contents into a room they did not choose.',
    )
    lines.push(
      '- To write an email, use gmail_draft_create. It puts a card in the chat'
        + ' with a Send button, which is how the person sends it. Do not send'
        + ' anything yourself unless they ask you to.',
    )
  }
  if (facts.hasCalendarTools) {
    lines.push(
      '- For scheduling, check availability before proposing times, and propose'
        + ' times rather than booking straight away unless asked to book.',
    )
  }
  return lines.join('\n')
}
