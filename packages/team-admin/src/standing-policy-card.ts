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
 * word for word — fenced, so nothing in them can render out of sight. Its one
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

/** A fence no run of backticks in the text can close. */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}\n${fence}`
}

/** One section cut into pieces that each fit a text block once fenced and titled. */
const sectionPieces = (title: string, text: string): string[] => {
  const room = TEXT_BLOCK_MAX - title.length - 40
  const pieces: string[] = []
  let rest = text
  while (rest.length > room) {
    const cut = rest.lastIndexOf('\n', room)
    const at = cut > room / 2 ? cut : room
    pieces.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  pieces.push(rest)
  return pieces.map((piece, index) => `**${title}${pieces.length > 1 ? ` (${index + 1} of ${pieces.length})` : ''}**`
    + `\n\n${fenced(piece)}`)
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
  return unable.map((machine) => `**${machine.label}:** This machine cannot merge; tickets will stop at an open `
    + 'pull request.').join('\n\n')
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
