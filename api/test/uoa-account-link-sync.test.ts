import assert from 'node:assert/strict'
import test from 'node:test'

import {
  setProductTeamEnablement,
  syncUoaProductAccountLinks,
} from '../src/services/integrations.js'

const syncInput = {
  email: 'person@example.com',
  externalSubject: 'uoa-user',
  organizationId: '00000000-0000-4000-8000-000000000001',
  teamId: '00000000-0000-4000-8000-000000000002',
  uoaTokenVersion: 8,
  userId: '00000000-0000-4000-8000-000000000003',
  workspaceDirectory: [{
    organizationId: 'uoa-org',
    teamId: 'uoa-team',
    avatarImageUrl: 'https://authentication.example.com/public/teams/uoa-team/avatar',
    label: 'Engineering',
    orgName: 'Example organization',
  }],
  workspace: {
    activeOrgId: 'uoa-org',
    activeTeamId: 'uoa-team',
    teamIds: ['uoa-team'],
    teamRoles: { 'uoa-team': 'owner' },
  },
}

const sqlText = (query: unknown): string => {
  const candidate = query as { strings?: readonly string[] }
  return candidate.strings?.join('?') ?? ''
}

const sqlValues = (query: unknown): readonly unknown[] => {
  const candidate = query as { values?: readonly unknown[] }
  return candidate.values ?? []
}

test('account-link sync rejects incomplete UOA proof before persistence', async () => {
  let queried = false
  const prisma = {
    $queryRaw: async () => {
      queried = true
      return []
    },
  }
  await assert.rejects(
    syncUoaProductAccountLinks(prisma as never, {
      ...syncInput,
      uoaTokenVersion: undefined,
    }),
    /requires an exact credential epoch/,
  )
  assert.equal(queried, false)
})

test('account-link sync fails closed without the canonical Nessie product', async () => {
  let transactionCalls = 0
  const prisma = {
    $queryRaw: async () => [{ slug: 'deep-water' }],
    $transaction: async () => {
      transactionCalls += 1
    },
  }
  await assert.rejects(
    syncUoaProductAccountLinks(prisma as never, syncInput),
    /Nessie account-link product is not provisioned/,
  )
  assert.equal(transactionCalls, 0)
})

test('account-link sync updates every first-party product under one transaction', async () => {
  const persistedDirectories: unknown[] = []
  const statements: string[] = []
  let transactionCalls = 0
  const prisma = {
    $queryRaw: async (query: unknown) => {
      assert.match(sqlText(query), /ORDER BY "slug" ASC/)
      return [{ slug: 'deep-water' }, { slug: 'nessie' }]
    },
    $transaction: async (operation: (tx: unknown) => Promise<void>) => {
      transactionCalls += 1
      return operation({
        $executeRaw: async (query: unknown) => {
          statements.push(sqlText(query))
          const metadataJson = sqlValues(query).find(
            (value) => typeof value === 'string' && value.includes('"workspaceDirectory"'),
          )
          assert.equal(typeof metadataJson, 'string')
          persistedDirectories.push(
            (JSON.parse(metadataJson as string) as { workspaceDirectory?: unknown }).workspaceDirectory,
          )
          return 1
        },
      })
    },
  }

  await syncUoaProductAccountLinks(prisma as never, syncInput)
  assert.equal(transactionCalls, 1)
  assert.equal(statements.length, 2)
  assert.deepEqual(persistedDirectories, [syncInput.workspaceDirectory, syncInput.workspaceDirectory])
  for (const statement of statements) {
    assert.match(statement, /"uoa_sub" = EXCLUDED\."uoa_sub"/)
    assert.match(
      statement,
      /"uoa_token_version"[\s\S]*<= EXCLUDED\."uoa_token_version"/,
    )
    assert.match(
      statement,
      /"metadata_json" = "product_account_links"\."metadata_json" \|\| EXCLUDED\."metadata_json"/,
    )
  }
})

test('an older login aborts the whole account-link transaction', async () => {
  let updates = 0
  const prisma = {
    $queryRaw: async () => [{ slug: 'deep-water' }, { slug: 'nessie' }],
    $transaction: async (operation: (tx: unknown) => Promise<void>) =>
      operation({
        $executeRaw: async () => {
          updates += 1
          return updates === 1 ? 1 : 0
        },
      }),
  }

  await assert.rejects(
    syncUoaProductAccountLinks(prisma as never, syncInput),
    /account-link state advanced/,
  )
  assert.equal(updates, 2)
})

test('team enablement uses the Team tuple and preserves drifted teardown metadata', async () => {
  let statement = ''
  const prisma = {
    $queryRaw: async (query: unknown) => {
      statement = sqlText(query)
      return []
    },
  }

  assert.equal(await setProductTeamEnablement(prisma as never, {
    enabled: true,
    organizationId: syncInput.organizationId,
    productSlug: 'deep-water',
    teamId: syncInput.teamId,
    userId: syncInput.userId,
  }), null)
  assert.match(statement, /t\."external_org_id"/)
  assert.match(statement, /t\."external_workspace_id"/)
  assert.match(statement, /t\."external_org_id" IS NOT NULL/)
  assert.match(statement, /t\."external_workspace_id" IS NOT NULL/)
  assert.match(statement, /COALESCE\([\s\S]*EXCLUDED\."external_org_id"/)
  assert.match(statement, /COALESCE\([\s\S]*EXCLUDED\."external_team_id"/)
  assert.doesNotMatch(statement, /account_link/)
})

test('the internal Nessie identity anchor cannot be toggled as an integration', async () => {
  let queried = false
  const prisma = {
    $queryRaw: async () => {
      queried = true
      return []
    },
  }
  assert.equal(await setProductTeamEnablement(prisma as never, {
    enabled: true,
    organizationId: syncInput.organizationId,
    productSlug: 'nessie',
    teamId: syncInput.teamId,
    userId: syncInput.userId,
  }), null)
  assert.equal(queried, false)
})
