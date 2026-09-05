import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_DESIGNER_SLUG,
  DASHBOARD_DESIGNER_SLUG,
} from '@nessie/team-admin'

import { loadGlobalAgentCatalogueBlock } from '../src/run/execute/global-agent-catalogue.js'
import type { RunContext } from '../src/run/execute/types.js'

/**
 * Who gets the agent-design catalogue.
 *
 * The block is ~18k characters about what an agent can be, and it closes by
 * saying where agents get built. It shipped keyed on "is a global agent", so
 * Dashboard Designer carried it into every run: two and a half times its own
 * persona, on a subject it has no tools for, ending in a sentence that told it
 * — inside its own single-member home DM — that it was in a shared channel.
 *
 * The rule is the blueprint's `identityToolIds`, which is the structural
 * statement of which specialist may ever hold the design verbs.
 */

const ORG = '11111111-1111-4111-8111-111111111111'

const contextFor = (systemSlug: string | null): RunContext =>
  ({
    agent: { agentKind: 'shared', id: '44444444-4444-4444-8444-444444444444', systemSlug },
    boundAgentIds: [],
    channel: {
      dmKey: null,
      id: '55555555-5555-4555-8555-555555555555',
      organizationId: ORG,
      systemChannelType: 'system_agent',
    },
  } as unknown as RunContext)

// Reaching Prisma at all would mean the blueprint gate did not short-circuit,
// so the fake answers nothing and throws if it is consulted.
const unreachablePrisma = new Proxy({}, {
  get: () => {
    throw new Error('the catalogue must not be assembled for this blueprint')
  },
}) as never

const load = (systemSlug: string | null) =>
  loadGlobalAgentCatalogueBlock(unreachablePrisma, contextFor(systemSlug), {
    actorContext: {} as never,
    ledgerIdentity: null,
    resolvedToolIds: new Set<string>(),
  })

test('a specialist that never holds the design verbs gets no agent-design catalogue', async () => {
  assert.equal(await load(DASHBOARD_DESIGNER_SLUG), null)
})

test('an agent with no blueprint gets no catalogue', async () => {
  assert.equal(await load(null), null)
  assert.equal(await load('withdrawn-blueprint'), null)
})

test('the Agent Designer still assembles it — the gate is the blueprint, not the run', async () => {
  // It gets past the blueprint gate and reaches the catalogue reads, which is
  // exactly what the unreachable Prisma proves by throwing.
  await assert.rejects(
    load(AGENT_DESIGNER_SLUG),
    /the catalogue must not be assembled for this blueprint/,
  )
})
