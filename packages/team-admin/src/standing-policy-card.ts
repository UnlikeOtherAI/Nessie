import { EXECUTOR_REVIEW_CARD_ACTION_KEY } from '@nessie/executor-manage'
import {
  AgentCardSpecSchema,
  EXECUTOR_CODING_MERGE_COMMANDS,
  STANDING_POLICY_ANY_COMMAND_OPTION,
  type AgentCardSpec,
  type StandingPolicyHostProfile,
  type StandingPolicyPinnedTerms,
} from '@nessie/schemas'

import { StandingPolicyRefusal } from './standing-policy-trigger.js'

/**
 * The one confirmation card of a standing policy, in plain words
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare and
 * confirm"; docs/standards/agent-cards.md). Server-written copy, like every
 * executor review card: the machines, the host profile and whether each can
 * merge, the board and its start-work columns, who can start work and who
 * sees it, the limits, that merges happen as the author, and the instructions
 * word for word — escaped, so nothing in them can render out of sight. Its one
 * action is the executor review card's `review`, whose press mints the
 * confirmation token for the author alone.
 */

export type StandingPolicyCardInput = {
  agentName: string
  boardEditorCount: number
  boardName: string
  /** What differs from the policy this one replaces, when it replaces one. */
  changes: string[] | null
  expiresAt: Date
  hostProfile: StandingPolicyHostProfile
  pickupColumnNames: string[]
  terms: StandingPolicyPinnedTerms
  triggerName: string
}

const TEXT_BLOCK_MAX = 2000
const INSTRUCTION_BLOCKS_MAX = 6

const SECTION_TITLES: ReadonlyArray<[string, string]> = [
  ['general', 'General'],
  ['onPickup', 'When work starts'],
  ['onTicketChanged', 'When the ticket changes'],
  ['onSessionTurnEnded', 'When a coding turn ends'],
  ['onReminder', 'When a reminder fires'],
  ['onQueued', 'When the ticket waits for a machine'],
]

const listed = (names: readonly string[]): string => names.length <= 1
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

const dollars = (amount: number): string => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** A leading space that stays a space in Markdown, where an ordinary one opens a code block. */
const NO_BREAK_SPACE = String.fromCharCode(160)

/**
 * One line of somebody's text as Markdown that renders exactly its
 * characters and still wraps: every ASCII punctuation mark is escaped, so no
 * emphasis, link, HTML, comment, list, heading or code fence can hide a word
 * or change one, and leading spaces stay spaces instead of opening a code
 * block. A fenced block would be literal too, but it does not wrap, and a
 * phone would show the author a sliver of what they agree to. A line of only
 * whitespace is a blank line, as Markdown reads it.
 */
const literalLine = (line: string): string => line.trim().length === 0 ? '' : line
  .replace(/[!-/:-@[-`{-~]/g, (mark) => `\\${mark}`)
  .replace(/^[ \t]+/, (lead) => NO_BREAK_SPACE.repeat(lead.length))

/**
 * Lines as literal text, one per line and a paragraph at each blank line. The
 * card's prose keeps a paragraph's line breaks as written (`white-space:
 * pre-wrap`), so a line needs no Markdown hard break, which would show twice.
 */
const literalText = (lines: readonly string[]): string => lines.map(literalLine).join('\n')

/** One section cut, on line boundaries where it can be, into pieces that each fit a text block titled. */
const sectionPieces = (title: string, text: string): string[] => {
  const room = TEXT_BLOCK_MAX - title.length - 30
  const groups: string[][] = [[]]
  for (const line of text.split('\n')) {
    // A line too long for a block on its own is cut; escaping at most doubles it.
    const parts = literalLine(line).length <= room
      ? [line]
      : Array.from({ length: Math.ceil(line.length / Math.floor(room / 2)) }, (_, at) => (
        line.slice(at * Math.floor(room / 2), (at + 1) * Math.floor(room / 2))
      ))
    for (const part of parts) {
      const group = groups[groups.length - 1] as string[]
      if (group.length > 0 && literalText([...group, part]).length > room) groups.push([part])
      else group.push(part)
    }
  }
  return groups.map((group, index) => `**${title}${groups.length > 1 ? ` (${index + 1} of ${groups.length})` : ''}**`
    + `\n\n${literalText(group)}`)
}

const instructionBlocks = (instructions: Record<string, string>): Array<{ markdown: string; type: 'text' }> => {
  const blocks: string[] = []
  for (const [key, title] of SECTION_TITLES) {
    const text = instructions[key]
    if (!text) continue
    for (const piece of sectionPieces(title, text)) {
      const last = blocks.at(-1)
      if (last !== undefined && last.length + piece.length + 2 <= TEXT_BLOCK_MAX) blocks[blocks.length - 1] = `${last}\n\n${piece}`
      else blocks.push(piece)
    }
  }
  if (blocks.length > INSTRUCTION_BLOCKS_MAX) {
    throw new StandingPolicyRefusal('The trigger\'s instructions are too long to show you word for word on one '
      + 'confirmation. Shorten them to about ten thousand characters, then set up machine access again.')
  }
  return blocks.map((markdown) => ({ markdown, type: 'text' }))
}

const budgetLine = (profile: StandingPolicyHostProfile): string => {
  const budgets = profile.machines.map((machine) => machine.maxBudgetUsd)
  return budgets.every((budget) => budget === budgets[0])
    ? `Claude Code, at most ${dollars(budgets[0] ?? 0)} a turn`
    : `Claude Code, at most ${profile.machines.map((machine) => `${dollars(machine.maxBudgetUsd)} a turn on `
      + machine.label).join(' and ')}`
}

const mergeLine = (profile: StandingPolicyHostProfile): string => {
  const unable = profile.machines.filter((machine) => (
    EXECUTOR_CODING_MERGE_COMMANDS.some((command) => !machine.mergeCommands.includes(command))
  ))
  if (unable.length === 0) return 'Each machine may push, open, watch and merge pull requests without asking.'
  return unable.map((machine) => `**${literalLine(machine.label)}:** This machine cannot merge; tickets will stop `
    + 'at an open pull request.').join('\n\n')
}

export const buildStandingPolicyCard = (input: StandingPolicyCardInput): AgentCardSpec => {
  const { hostProfile, terms } = input
  const minutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000))
  const machines = listed(hostProfile.machines.map((machine) => machine.label))
  return AgentCardSpecSchema.parse({
    actions: [{ key: EXECUTOR_REVIEW_CARD_ACTION_KEY, label: 'Review', style: 'primary', submits: true }],
    blocks: [
      {
        markdown: `Anyone who can edit this board (${plural(input.boardEditorCount, 'person', 'people')}) can make `
          + 'Claude run commands on these machines as you, with your git and coding-agent login.\n\n'
          + 'Project members, organisation owners and people on the ticket see what the work does on the ticket: '
          + 'the coding agent\'s summaries and its pull requests. Pull requests are merged under your GitHub '
          + 'identity.',
        type: 'text',
      },
      {
        items: [
          { label: 'Machines', value: machines },
          { label: 'Board', value: input.boardName },
          { label: 'Starts work in', value: listed(input.pickupColumnNames) },
          { label: 'Coding agent', value: budgetLine(hostProfile) },
          {
            label: 'Commands',
            value: hostProfile.allowAnyCommand
              ? `Any, without asking: you chose "${STANDING_POLICY_ANY_COMMAND_OPTION}"`
              : 'Only what each machine\'s reviewed configuration allows without asking',
          },
          { label: 'Coding roots', value: listed(hostProfile.allowedRootNames) },
          {
            label: 'Each ticket',
            value: `At most ${plural(terms.limits.ticketHours, 'hour', 'hours')}, ${dollars(terms.limits.ticketUsd)} `
              + `and ${plural(terms.limits.wakesPerTicket, 'wake', 'wakes')}`,
          },
          {
            label: 'Each day',
            value: `At most ${plural(terms.limits.startsPerDay, 'ticket', 'tickets')} started and `
              + `${dollars(terms.limits.dailyUsd)} spent`,
          },
        ],
        type: 'fields',
      },
      { markdown: mergeLine(hostProfile), type: 'text' },
      ...(input.changes && input.changes.length > 0
        ? [{ markdown: `**Changed since you last confirmed:** ${listed(input.changes)}.`, type: 'text' }]
        : []),
      { blocks: instructionBlocks(terms.instructions), summary: 'The instructions, word for word', type: 'details' },
      {
        markdown: 'Review opens exactly what you agree to. Nothing is applied until you confirm it there, with your '
          + `password. This expires in ${plural(minutes, 'minute', 'minutes')}.`,
        type: 'text',
      },
    ],
    schemaVersion: 1,
    subtitle: `Ticket work from "${input.triggerName}"`.slice(0, 200),
    title: `Let ${input.agentName} use ${machines}`.slice(0, 120),
  })
}
