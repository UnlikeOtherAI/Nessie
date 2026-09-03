import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import {
  AGENT_DESIGNER_BLUEPRINT,
  AGENT_DESIGNER_SLUG,
  globalAgentHomeDmKey,
} from '@nessie/team-admin'

import {
  agentActsAsRequestingPerson,
  isDelegatedSystemDmChannelType,
  isGlobalAgentHomeSurface,
  resolveDelegatedRequesterUserId,
  resolveIdentityDelegatedToolIds,
  runDelegatesToRequestingPerson,
  type DelegatedRunFacts,
} from '../src/run/delegated-identity.js'
import { authorizeToolCall, resolveAgentTools } from '../src/run/tool-policy.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const USER = '22222222-2222-4222-8222-222222222222'
const OTHER_USER = '33333333-3333-4333-8333-333333333333'

const HOME_DM_KEY = globalAgentHomeDmKey({
  organizationId: ORG,
  slug: AGENT_DESIGNER_SLUG,
  userId: USER,
})

const designerHome: DelegatedRunFacts = {
  agentKind: 'shared',
  dmKey: HOME_DM_KEY,
  organizationId: ORG,
  systemChannelType: 'system_agent',
  systemSlug: AGENT_DESIGNER_SLUG,
}

const IDENTITY_TOOL = 'agent_create'
const NON_IDENTITY_PA_TOOL = 'send_message'

/** Moved to the Agent Designer in phase 4 — the PA hands off instead. */
const DESIGNER_RESERVED_TOOLS = [
  'agent_avatar_update',
  'agent_create',
  'agent_read',
  'agent_tool_catalog',
  'agent_update',
]
/** The operational verbs on existing agents, which stay with the PA. */
const PA_OPERATIONAL_AGENT_TOOLS = [
  'agent_bind_channel',
  'agent_list',
  'agent_trigger_create',
  'channel_create',
]

// The gate is only meaningful if these really are `personalAssistantOnly`
// builtins — a rename would otherwise quietly turn every case below green.
test('the blueprint names real personalAssistantOnly builtins', () => {
  for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
    const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
    assert.ok(definition, `${toolId} in identityToolIds is not a builtin`)
    assert.equal(
      definition.personalAssistantOnly,
      true,
      `${toolId} is not personalAssistantOnly, so the gate arm would be pointless`,
    )
  }
  const nonIdentity = BUILTIN_TOOL_DEFINITIONS.find((t) => t.id === NON_IDENTITY_PA_TOOL)
  assert.equal(nonIdentity?.personalAssistantOnly, true)
  assert.ok(!AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes(NON_IDENTITY_PA_TOOL))

  // The retirement is expressed on the definitions, and the Designer's
  // blueprint must still declare every one it took over — otherwise the tool
  // would be reachable by nobody at all.
  for (const toolId of DESIGNER_RESERVED_TOOLS) {
    const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
    assert.equal(definition?.identityDelegatedOnly, true, `${toolId} is not designer-reserved`)
    assert.ok(
      AGENT_DESIGNER_BLUEPRINT.identityToolIds.includes(toolId),
      `${toolId} is reserved but no blueprint declares it`,
    )
  }
  for (const toolId of PA_OPERATIONAL_AGENT_TOOLS) {
    const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
    assert.notEqual(definition?.identityDelegatedOnly, true, `${toolId} left the PA by accident`)
  }
})

test('the delegation predicate is true for the two delegate surfaces and nothing else', () => {
  assert.equal(runDelegatesToRequestingPerson(designerHome), true)
  assert.equal(
    runDelegatesToRequestingPerson({
      agentKind: 'personal_assistant',
      organizationId: ORG,
      systemChannelType: 'personal_assistant',
    }),
    true,
  )

  // A PA presence in a shared room still acts as its owner, but the room is not
  // that owner's private surface.
  assert.equal(
    runDelegatesToRequestingPerson({
      agentKind: 'personal_assistant',
      organizationId: ORG,
      systemChannelType: null,
    }),
    false,
  )
  assert.equal(
    agentActsAsRequestingPerson({ agentKind: 'personal_assistant', systemSlug: null }),
    true,
  )

  // Same global agent, wrong surface / wrong organisation / no blueprint.
  assert.equal(
    runDelegatesToRequestingPerson({ ...designerHome, systemChannelType: null, dmKey: null }),
    false,
  )
  assert.equal(
    runDelegatesToRequestingPerson({ ...designerHome, organizationId: OTHER_ORG }),
    false,
  )
  assert.equal(
    runDelegatesToRequestingPerson({ ...designerHome, systemSlug: 'not-a-blueprint' }),
    false,
  )
  assert.equal(runDelegatesToRequestingPerson({ ...designerHome, systemSlug: null }), false)

  // Another person's home DM of the same blueprint IS a home surface: the check
  // is "a home of this blueprint in this org", and sole membership is what ties
  // it to one person. Placement and the message-create stamp own that half.
  assert.equal(
    isGlobalAgentHomeSurface({
      ...designerHome,
      dmKey: globalAgentHomeDmKey({
        organizationId: ORG,
        slug: AGENT_DESIGNER_SLUG,
        userId: OTHER_USER,
      }),
    }),
    true,
  )
})

test('isDelegatedSystemDmChannelType covers exactly the two system DM types', () => {
  assert.equal(isDelegatedSystemDmChannelType('personal_assistant'), true)
  assert.equal(isDelegatedSystemDmChannelType('system_agent'), true)
  assert.equal(isDelegatedSystemDmChannelType('external_agent'), false)
  assert.equal(isDelegatedSystemDmChannelType(null), false)
})

test('the requester must be interactive, a user, and the stamped effective user', () => {
  const base = {
    actorId: USER,
    actorType: 'user',
    effectiveUserId: USER,
    interactive: true,
  }
  assert.equal(resolveDelegatedRequesterUserId(base), USER)
  assert.equal(resolveDelegatedRequesterUserId({ ...base, interactive: false }), null)
  assert.equal(resolveDelegatedRequesterUserId({ ...base, interactive: undefined }), null)
  assert.equal(resolveDelegatedRequesterUserId({ ...base, actorType: 'agent' }), null)
  assert.equal(resolveDelegatedRequesterUserId({ ...base, effectiveUserId: null }), null)
  // A PA-presence shape: the owner is the effective user while somebody else
  // did the asking. Not a delegation an identity tool may ride.
  assert.equal(
    resolveDelegatedRequesterUserId({ ...base, effectiveUserId: OTHER_USER }),
    null,
  )
})

test('identity tools resolve only for the blueprint, on its home, on an interactive turn', () => {
  const admitted = resolveIdentityDelegatedToolIds(designerHome, USER)
  assert.deepEqual(
    [...admitted].sort(),
    [...AGENT_DESIGNER_BLUEPRINT.identityToolIds].sort(),
  )

  // Unattended: the load-bearing arm. A trigger-fired run reconstructs an
  // absent creator's effectiveUserId, so this is what stops a scheduled run
  // creating agents and channels as that person.
  assert.equal(resolveIdentityDelegatedToolIds(designerHome, null).size, 0)

  // Any other channel.
  assert.equal(
    resolveIdentityDelegatedToolIds(
      { ...designerHome, dmKey: null, systemChannelType: null },
      USER,
    ).size,
    0,
  )

  // An ordinary shared agent sitting in a system_agent DM.
  assert.equal(
    resolveIdentityDelegatedToolIds({ ...designerHome, systemSlug: null }, USER).size,
    0,
  )

  // The PA passes on its own agentKind arm, never through a blueprint list.
  assert.equal(
    resolveIdentityDelegatedToolIds(
      {
        agentKind: 'personal_assistant',
        organizationId: ORG,
        systemChannelType: 'personal_assistant',
      },
      USER,
    ).size,
    0,
  )
})

const enabled = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((t) => t.requiresExplicitGrant !== true).map((t) => t.id),
)

const authorize = (
  toolId: string,
  agentKind: 'personal_assistant' | 'shared',
  identityToolIds?: ReadonlySet<string>,
) =>
  authorizeToolCall(
    toolId,
    enabled,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    agentKind,
    { ...(identityToolIds ? { identityToolIds } : {}) },
  )

test('the gate admits a declared identity tool for the Designer in its home DM', () => {
  const admitted = resolveIdentityDelegatedToolIds(designerHome, USER)
  assert.deepEqual(authorize(IDENTITY_TOOL, 'shared', admitted), { allowed: true })
})

test('the gate denies the same tool everywhere else, and unattended', () => {
  for (const facts of [
    { ...designerHome, dmKey: null, systemChannelType: null },
    { ...designerHome, organizationId: OTHER_ORG },
  ]) {
    assert.deepEqual(
      authorize(IDENTITY_TOOL, 'shared', resolveIdentityDelegatedToolIds(facts, USER)),
      { allowed: false, reason: 'personal_assistant_only' },
    )
  }
  assert.deepEqual(
    authorize(IDENTITY_TOOL, 'shared', resolveIdentityDelegatedToolIds(designerHome, null)),
    { allowed: false, reason: 'personal_assistant_only' },
  )
})

test('the gate denies an identity tool to an ordinary shared agent everywhere', () => {
  assert.deepEqual(authorize(IDENTITY_TOOL, 'shared'), {
    allowed: false,
    reason: 'personal_assistant_only',
  })
  assert.deepEqual(
    authorize(
      IDENTITY_TOOL,
      'shared',
      resolveIdentityDelegatedToolIds({ ...designerHome, systemSlug: null }, USER),
    ),
    { allowed: false, reason: 'personal_assistant_only' },
  )
})

test('a PA-only tool the blueprint does not declare stays denied for the Designer', () => {
  const admitted = resolveIdentityDelegatedToolIds(designerHome, USER)
  assert.deepEqual(authorize(NON_IDENTITY_PA_TOOL, 'shared', admitted), {
    allowed: false,
    reason: 'personal_assistant_only',
  })
})

test('the personal assistant keeps the PA-only tools that are not designer-reserved', () => {
  assert.deepEqual(authorize(NON_IDENTITY_PA_TOOL, 'personal_assistant'), { allowed: true })
  for (const toolId of PA_OPERATIONAL_AGENT_TOOLS) {
    assert.deepEqual(
      authorize(toolId, 'personal_assistant'),
      { allowed: true },
      `${toolId} is an operational verb the PA keeps`,
    )
  }
})

// Phase 4 (D8): creating and redesigning an agent moved to the Agent Designer.
// The tools are not deleted — the Designer needs them — so the retirement is a
// flag on the definition that removes the PA's kind arm, leaving only the
// identity-delegated one.
test('the personal assistant no longer reaches the designer-reserved tools', () => {
  for (const toolId of DESIGNER_RESERVED_TOOLS) {
    assert.deepEqual(
      authorize(toolId, 'personal_assistant'),
      { allowed: false, reason: 'personal_assistant_only' },
      `${toolId} must be unreachable from the Personal Assistant`,
    )
  }

  const paToolset = resolveAgentTools(
    enabled,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    'personal_assistant',
    { inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length },
  )
  for (const toolId of DESIGNER_RESERVED_TOOLS) {
    assert.equal(
      paToolset.allowedIds.has(toolId),
      false,
      `${toolId} must be omitted from the PA's schema array, not offered then denied`,
    )
  }
  for (const toolId of PA_OPERATIONAL_AGENT_TOOLS) {
    assert.equal(paToolset.allowedIds.has(toolId), true)
  }
  // The doorway that replaces them.
  assert.equal(paToolset.allowedIds.has('agent_handoff'), true)
})

test('the Designer still reaches every designer-reserved tool in its home DM', () => {
  const admitted = resolveIdentityDelegatedToolIds(designerHome, USER)
  for (const toolId of DESIGNER_RESERVED_TOOLS) {
    assert.deepEqual(
      authorize(toolId, 'shared', admitted),
      { allowed: true },
      `${toolId} must survive the retirement for the Designer`,
    )
  }
})

test('toolset assembly OMITS the identity tools when the conditions do not hold', () => {
  const build = (identityToolIds: ReadonlySet<string>) =>
    resolveAgentTools(enabled, BUILTIN_TOOL_DEFINITIONS, AGENT_DESIGNER_BLUEPRINT.toolPolicy, null, 'shared', {
      identityToolIds,
      inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length,
    })

  const inHome = build(resolveIdentityDelegatedToolIds(designerHome, USER))
  const elsewhere = build(
    resolveIdentityDelegatedToolIds({ ...designerHome, systemChannelType: null }, USER),
  )

  for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
    assert.equal(inHome.allowedIds.has(toolId), true, `${toolId} must be offered at home`)
    assert.ok(
      inHome.descriptors.some((descriptor) => descriptor.toolName === toolId),
      `${toolId} must appear in the schema array at home`,
    )
    assert.equal(elsewhere.allowedIds.has(toolId), false)
    // Never offer-then-deny: the schema array must not carry it at all.
    assert.ok(!elsewhere.descriptors.some((descriptor) => descriptor.toolName === toolId))
    assert.ok(!elsewhere.stubbedIds.has(toolId))
  }

  // The blueprint's deny-mode narrowing still holds in both cases.
  for (const denied of ['delegate', 'spawn_subtask']) {
    assert.equal(inHome.allowedIds.has(denied), false)
  }
  // And a PA-only tool it never declared is absent even at home.
  assert.equal(inHome.allowedIds.has(NON_IDENTITY_PA_TOOL), false)
})
