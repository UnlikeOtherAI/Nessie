import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deepWaterAgentAccessKey,
  deepWaterResearchRunsKey,
  integratedProductsKey,
  mcpToolRegistryKey,
  toolPolicyTargetsKey,
} from '../../admin/src/facades/integrations/keys.js'

const ownerScope = {
  isOwner: true,
  organizationId: 'org-a',
  teamId: 'team-a',
  userId: 'user-a',
}

test('integration caches are isolated by actor, organization, team, and privilege', () => {
  const variants = [
    ownerScope,
    { ...ownerScope, isOwner: false },
    { ...ownerScope, organizationId: 'org-b' },
    { ...ownerScope, teamId: 'team-b' },
    { ...ownerScope, userId: 'user-b' },
  ]

  for (const keyBuilder of [
    integratedProductsKey,
    deepWaterResearchRunsKey,
    deepWaterAgentAccessKey,
  ]) {
    const keys = variants.map((scope) => JSON.stringify(keyBuilder(scope)))
    assert.equal(new Set(keys).size, variants.length)
  }

  assert.notDeepEqual(
    mcpToolRegistryKey(ownerScope, true, {}),
    mcpToolRegistryKey({ ...ownerScope, isOwner: false }, false, {}),
  )
  assert.notDeepEqual(
    mcpToolRegistryKey(ownerScope, true, {}),
    mcpToolRegistryKey({ ...ownerScope, teamId: 'team-b' }, true, {}),
  )
})

test('tool-policy targets cannot reuse an owner cache for another actor or role', () => {
  const keys = [
    toolPolicyTargetsKey(ownerScope),
    toolPolicyTargetsKey({ ...ownerScope, isOwner: false }),
    toolPolicyTargetsKey({ ...ownerScope, organizationId: 'org-b' }),
    toolPolicyTargetsKey({ ...ownerScope, userId: 'user-b' }),
  ].map((key) => JSON.stringify(key))

  assert.equal(new Set(keys).size, keys.length)
})
