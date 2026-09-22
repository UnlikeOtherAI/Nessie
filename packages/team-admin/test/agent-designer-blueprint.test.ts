import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DESIGNER_BLUEPRINT } from '../src/global-agent-blueprints.js'

/**
 * The Agent Designer's persona, pinned where it was wrong on 2026-09-22.
 *
 * Asked for a CTO, it made a channel for the CTO nobody had asked for,
 * because the prompt told it to "find or create" the channels the work happens
 * in and to create "the channel it works in". A new agent lives in the
 * channels the person names, or nowhere yet; `channel_create` stays for a
 * person who asks for a channel.
 */

const prompt = AGENT_DESIGNER_BLUEPRINT.buildSystemPrompt({ organizationId: 'org-1' })
// The persona is written as wrapped lines; a rule is read across them.
const prose = prompt.replace(/\s+/g, ' ')

test('a new agent lives in the channels named, or nowhere yet', () => {
  assert.match(prose, /in the existing channels they named, or nowhere yet/)
  assert.match(prose, /that is a finished agent — people add it to any channel/)
  assert.match(prose, /never make a channel for it/)
  assert.doesNotMatch(prose, /find or create/)
  assert.doesNotMatch(prose, /the channel it works in/)
  assert.doesNotMatch(AGENT_DESIGNER_BLUEPRINT.handoffSummary, /the channel it works in/)
  assert.match(AGENT_DESIGNER_BLUEPRINT.handoffSummary, /where it lives/)
})

test('a channel is made only when a person asks for one', () => {
  assert.match(prose, /When they ask for a new channel/)
  assert.match(prose, /creating a channel is never a step in building an agent/)
  // Still a tool it holds: a person who does ask is served in this chat.
  assert.equal(AGENT_DESIGNER_BLUEPRINT.toolPolicy.channel_create, true)
  assert.ok(AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes('channel_create'))
})

// F9. The rules the Designer follows about its own words are the prompt's,
// not text inside a tool result, where it relayed "give them this reason word
// for word" to the person as it stood.
test('the portrait reason is quoted because the prompt says so', () => {
  assert.match(prose, /give the reason agent_create reported word for word/)
})

test('it links what it made and never shows a raw id', () => {
  assert.match(prose, /markdown links your tools return, such as \[#sales\]\(\/channels\/…\)/)
  assert.match(prose, /never a raw id/)
})
