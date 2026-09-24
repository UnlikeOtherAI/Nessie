import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

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

// F22 against F11: "nowhere yet" is a finished agent, but board tools are lent
// only in a channel of the board's own project. A CTO that owns a board and
// lives nowhere holds `ticket_*` grants no run ever lends it.
test('an agent that works a board lives in one of that project\'s channels', () => {
  assert.match(prose, /An agent whose work is a project's board — its tickets — reaches that board only from a channel of that project it lives in/)
  assert.match(prose, /such an agent lives in at least one existing channel of that project: ask which one/)
  assert.match(prose, /say plainly that it cannot touch the board until someone adds it to one of that project's channels/)
})

// F9 took `agentId=` out of agent_create's output, so a later call finds the
// id in the link. The model is told where; it is not left to guess.
test('the ids later calls need are named as the links\' last segments', () => {
  assert.match(prose, /the agentId that agent_bind_channel, agent_update, agent_trigger_create or executor_agent_grant_prepare takes is the last path segment of the \/agents\/<id> link agent_create or agent_list returned/)
})

// A trigger's link is `/agents/triggers/<id>`, which "an /agents/… link" also
// describes; agent_trigger_create's result prints it before the agent's. A
// model reading that rule literally took the trigger's id as the agentId.
test('a trigger link is never read as an agent\'s', () => {
  assert.ok(prose.includes(
    '/agents/<id> link agent_create or agent_list returned '
    + '(a /agents/triggers/… link is a trigger, never an agent)',
  ))
  assert.doesNotMatch(prose, /agentId[^.]*the last path segment of the \/agents\/… link/)
})

// project_create, agent_list and agent_trigger_create stopped printing
// `projectId=`/`agentId=`/`triggerId=` too (agent_list is in the test above),
// so each is named with the link a later call reads its id from.
test('a project and a trigger are read from their links too', () => {
  assert.match(prose, /the projectId channel_create or team_create takes the last segment of the \/projects\/… link project_create returned/)
  assert.match(prose, /the triggerId agent_trigger_update or agent_trigger_delete takes the last segment of the \/agents\/triggers\/… link agent_trigger_create returned/)
})

// T1 of docs/plans/2026-09-23-ticket-driven-agents: an agent that picks up a
// board's tickets is set up agent, then a public project channel, then its
// board tools, then the trigger, from the ids project_structure_read
// returned, with instructions the Designer drafts. No machine does ticket
// work yet, so none is promised.
test('a ticket-driven agent is set up in order, from the project\'s real structure', () => {
  assert.ok(prose.includes(
    'Set it up in this order: create the agent, bind it to a channel of the board\'s project that every member '
    + 'can read — a public one — then give it the board tools its work needs, with agent_tool_access_set '
    + 'setting ticket_read, ticket_comment_add and ticket_move true',
  ))
  assert.ok(prose.includes(
    'and then create the trigger with that channel as its target. The trigger\'s answer names any of those '
    + 'tools the agent still lacks',
  ))
  assert.ok(AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes('agent_tool_access_set'))
  assert.match(prose, /Read the project with project_structure_read first/)
  assert.match(prose, /name a column by its name or category rather than by an id you have not seen/)
  assert.match(prose, /When the trigger is refused, fix the field the refusal names/)
  assert.match(prose, /A neutral example: general "Read the ticket, its description and its comments before you act/)
  assert.match(prose, /Ticket work runs on no machine yet, so never promise that the agent will write or run code/)
  assert.equal(AGENT_DESIGNER_BLUEPRINT.toolPolicy['project_structure_read'], true)
  assert.ok(AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes('project_structure_read'))
})

test('a pinned portrait style is reported because the prompt says so', () => {
  assert.match(prose, /When a redraw reports its style as pinned, tell them the style they asked for was not used/)
})

// The owner's rule (2026-09-23): the Designer acts with the full reach of the
// person asking. Anything act-as-user the Personal Assistant holds must reach
// the Designer's home DM, except the verbs whose handlers refuse every face
// but the PA's own conversation — a curated subset is the defect this replaced.
test('the Designer holds every act-as-user verb its handlers do not refuse', () => {
  const paOnly = BUILTIN_TOOL_DEFINITIONS
    .filter((tool) => tool.personalAssistantOnly === true)
  const held = new Set(AGENT_DESIGNER_BLUEPRINT.identityToolIds)
  const paDmOnly = ['app_connect_request', 'pa_join_channel']
  const outside = paOnly.filter((tool) => !held.has(tool.id))
  for (const tool of outside) {
    assert.ok(
      paDmOnly.includes(tool.id) || tool.requiresExplicitGrant === true,
      `${tool.id} is outside the delegated set with no refusing handler and no explicit-grant gate`,
    )
  }
  for (const id of paDmOnly) {
    assert.ok(!held.has(id), `${id} hard-refuses non-PA faces and must not be offered`)
  }
  // And no held verb is grant-gated: identity delegation never stands in for
  // an owner's per-agent allow, so a held one would be offered-then-denied.
  for (const tool of paOnly) {
    if (held.has(tool.id)) {
      assert.notEqual(tool.requiresExplicitGrant, true, `${tool.id} is grant-gated yet declared`)
    }
  }
})
