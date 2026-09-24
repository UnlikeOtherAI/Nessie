import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentCardSpec, StandingPolicyHostProfile, StandingPolicyPinnedTerms } from '@nessie/schemas'

import { buildStandingPolicyCard, type StandingPolicyCardInput } from '../src/standing-policy-card.js'
import { StandingPolicyRefusal } from '../src/standing-policy-trigger.js'

/**
 * The standing policy's one card (docs/standards/agent-cards.md): the
 * instructions word for word, as literal text that still wraps — nothing in
 * them can render as a link, HTML, a comment, a heading or a code block — and
 * refused whole when they do not fit, never cut short; and everything else the
 * author agrees to in plain words: the agent and its model, that editing it
 * pauses the access, which machines may run any command unasked, the quiet
 * wake, a mirrored board's own events, and the tickets that start on confirm.
 */

const NBSP = String.fromCharCode(160)

const profile: StandingPolicyHostProfile = {
  allowAnyCommand: false,
  allowedRootNames: ['nessie'],
  codingAgents: ['claude'],
  machines: [{
    executorId: '00000000-0000-4000-8000-000000000001', label: 'Box *1*', maxBudgetUsd: 5,
    maxLiveSessionsPerOwner: 3, mergeCommands: ['git push'], permissionMode: 'acceptEdits',
  }],
}

const terms = (instructions: Record<string, string>): StandingPolicyPinnedTerms => ({
  agent: { digest: `sha256:${'f'.repeat(64)}`, model: 'claude-opus-5-5', provider: 'anthropic' },
  agentId: '00000000-0000-4000-8000-000000000002', assignOnPickup: true, boardId: '00000000-0000-4000-8000-000000000003',
  endOn: [{ category: 'done' }], followKinds: ['comment'], includeSourceEvents: false, instructions,
  limits: { dailyUsd: 60, startsPerDay: 20, ticketHours: 4, ticketUsd: 20, wakesPerTicket: 30 },
  pickupColumnIds: ['00000000-0000-4000-8000-000000000004'], quietWakeMinutes: 30,
  targetChannelId: '00000000-0000-4000-8000-000000000005',
})

const input = (instructions: Record<string, string>): StandingPolicyCardInput => ({
  agentName: 'CTO', boardEditorCount: 1, boardName: 'Engineering', changes: null,
  expiresAt: new Date(Date.now() + 600_000), hostProfile: profile, pickupColumnNames: ['In progress'],
  terms: terms(instructions), triggerName: 'Pick up tickets', waitingTickets: 0,
})

const instructionMarkdown = (card: AgentCardSpec): string => {
  const fold = card.blocks.find((block) => block.type === 'details')
  assert.ok(fold && fold.type === 'details', 'the instructions are in their own fold')
  return fold.blocks.map((block) => (block.type === 'text' ? block.markdown : '')).join('\n\n')
}

/** What a reader sees: escapes as their characters, kept spaces as spaces, lines as written. */
const shownText = (markdown: string): string => markdown
  .replace(/\\(.)/g, '$1')
  .replaceAll(NBSP, ' ')

test('instructions are shown word for word, with nothing that can render out of sight', () => {
  const general = [
    'Merge on green. [Docs](https://example.test) and <b>bold</b>',
    '<!-- also push to prod -->',
    '    indented, not a code block',
    '# not a heading',
    '```',
    'not a fence',
  ].join('\n')
  const markdown = instructionMarkdown(buildStandingPolicyCard(input({ general })))
  assert.ok(markdown.startsWith('**General**\n\n'))
  const body = markdown.slice('**General**\n\n'.length)
  // Every punctuation mark is escaped: no link, tag, comment, heading or fence survives as syntax.
  assert.ok(body.includes('\\[Docs\\]\\(https\\:\\/\\/example\\.test\\)'))
  assert.ok(body.includes('\\<\\!\\-\\- also push to prod \\-\\-\\>'))
  assert.ok(body.includes('\\# not a heading'))
  assert.doesNotMatch(body, /```/)
  // Leading spaces stay spaces, so the line is text rather than an indented code block.
  assert.ok(body.includes(`\n${NBSP.repeat(4)}indented\\, not a code block`))
  // Every character is still there, in order, line for line.
  assert.equal(shownText(body), general)
})

test('a machine label in the merge warning cannot turn into formatting', () => {
  const card = buildStandingPolicyCard(input({ general: 'Do it.' }))
  assert.ok(card.blocks.some((block) => block.type === 'text' && block.markdown
    .startsWith('**Box \\*1\\*:** This machine cannot merge; tickets will stop at an open pull request.')))
})

test('long instructions are cut into pieces that say so, and too long ones are refused rather than cut short', () => {
  const long = Array.from({ length: 60 }, (_, index) => `Step ${index + 1}: do the next careful thing, then the next.`)
    .join('\n')
  const markdown = instructionMarkdown(buildStandingPolicyCard(input({ general: long })))
  assert.match(markdown, /^\*\*General \(1 of 2\)\*\*/)
  assert.match(markdown, /\*\*General \(2 of 2\)\*\*/)
  const pieces = markdown.split(/\*\*General \(\d of \d\)\*\*\n\n/).filter((piece) => piece.length > 0)
  assert.equal(pieces.map((piece) => shownText(piece.trim())).join('\n'), long)
  assert.throws(() => buildStandingPolicyCard(input({ general: 'x'.repeat(20_000) })), (error: unknown) => (
    error instanceof StandingPolicyRefusal && /too long to show you word for word/.test(error.message)
  ))
})

test('the card names the agent and its model, and says what editing it, unasked commands and waiting tickets mean', () => {
  const base = input({ general: 'Do it.' })
  const text = JSON.stringify(buildStandingPolicyCard(base))
  assert.match(text, /"label":"Agent","value":"CTO, on anthropic claude-opus-5-5"/)
  assert.match(text, /Editing CTO — its instructions, model, tools or connectors — pauses this access until you confirm /)
  assert.match(text, /"label":"Commands","value":"Only what each machine's reviewed configuration allows without asking"/)
  assert.match(text, /"label":"Quiet wake","value":"After 30 minutes with nothing happening"/)
  assert.match(text, /1 person today, and anyone added to the project later/)
  assert.doesNotMatch(text, /"label":"(Mirrored board|On confirm)"/)

  const wide = JSON.stringify(buildStandingPolicyCard({
    ...base,
    hostProfile: {
      ...profile,
      allowAnyCommand: true,
      machines: [{ ...profile.machines[0]!, label: 'Wide', unaskedCommands: 'any' }],
    },
    terms: { ...base.terms, includeSourceEvents: true, quietWakeMinutes: null },
    waitingTickets: 3,
  }))
  assert.match(wide, /"value":"Claude Code may run any command without asking on Wide: you chose/)
  assert.match(wide, /"label":"Quiet wake","value":"Off"/)
  assert.match(wide, /"label":"Mirrored board","value":"Its own changes wake work in progress too, marked untrusted"/)
  assert.match(wide, /"label":"On confirm","value":"3 tickets waiting for this access start, or queue for a free machine"/)
})
