/**
 * Keeping a mailbox out of the orchestrator's context window.
 *
 * A mailbox is unboundedly large and the interesting part is almost never the
 * raw text — it is the answer. So a Gmail or Calendar read that overflows a
 * modest cap does NOT get truncated silently and does not get a bigger cap:
 * it comes back trimmed, with the count that was withheld and an instruction
 * to hand the reading to a sub-agent, which has the same tools and its own
 * context window and reports back a digest.
 *
 * The main thread stays an orchestrator. This mirrors the research-routing
 * convention (`research-routing.ts`) and reuses the same `delegate` machinery
 * rather than inventing a second one.
 */

/**
 * The cap. Deliberately the same size as `web_search`'s preview
 * (`MAX_PREVIEW_LENGTH`): a mailbox result is discovery material of exactly
 * that kind, and anything that does not fit is a job for a sub-agent.
 */
export const MAX_MAILBOX_RESULT_CHARS = 4_000

export type MailboxOverflowContext = {
  /** What was being read, in the words the model should reuse. */
  what: string
  /** A concrete, self-contained task the sub-agent could be given. */
  delegateTask: string
}

const overflowNote = (
  context: MailboxOverflowContext,
  withheld: string,
): string =>
  [
    `[${withheld} not included — this ${context.what} is larger than one turn`
      + ' should carry.]',
    'Do not re-run this with a narrower query just to see the rest, and do not'
      + ' page through it here. Hand the reading to a sub-agent and work from'
      + ' what it reports:',
    `delegate({ task: "${context.delegateTask}" })`,
    'The sub-agent has the same mailbox and calendar tools, its own context, and'
      + ' returns a digest instead of raw messages.',
  ].join('\n')

/**
 * Serialize a tool result, trimming to whole records when it overflows.
 *
 * Arrays lose entries from the end — a search returns newest first, so the
 * front of the list is the part worth keeping — and the caller is told exactly
 * how many were dropped. A single oversized record (one very long email) is
 * cut with the same instruction, because the useful move there is also to let
 * a sub-agent read it.
 */
export const serializeMailboxResult = (
  value: unknown,
  context: MailboxOverflowContext,
): string => {
  const full = JSON.stringify(value)
  if (full.length <= MAX_MAILBOX_RESULT_CHARS) return full

  if (Array.isArray(value)) {
    const kept: unknown[] = []
    for (const entry of value) {
      const candidate = JSON.stringify([...kept, entry])
      // Leave room for the note itself, so the whole result still fits.
      if (candidate.length > MAX_MAILBOX_RESULT_CHARS - 600) break
      kept.push(entry)
    }
    const withheld = value.length - kept.length
    // Every record is too large to show even one: fall through to the
    // single-record wording rather than returning an empty list.
    if (kept.length > 0) {
      return [
        JSON.stringify(kept),
        overflowNote(context, `${withheld} of ${value.length} results`),
      ].join('\n\n')
    }
  }

  return [
    `${full.slice(0, MAX_MAILBOX_RESULT_CHARS - 600)}…`,
    overflowNote(context, 'the rest'),
  ].join('\n\n')
}
