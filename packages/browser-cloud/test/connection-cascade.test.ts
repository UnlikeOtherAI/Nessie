import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConnectionForRun } from '../src/session-lifecycle.js'

type Row = { id: string; scope: string; projectId: string; apiKeyRef: string; userId: string | null }

const connection = (scope: string, id: string): Row => ({
  apiKeyRef: `secret_${id}`,
  id,
  projectId: `proj_${id}`,
  scope,
  userId: scope === 'user' ? 'user-1' : null,
})

type SettingRow = { scope: string; value: unknown; locked: boolean; key: string }

const fakePrisma = (rows: Row[], settingRows: SettingRow[]) => ({
  cloudBrowserConnection: {
    findMany: async ({ where }: { where: { OR: Array<{ scope: string }> } }) => {
      const reachable = new Set(where.OR.map((clause) => clause.scope))
      return rows.filter((row) => reachable.has(row.scope))
    },
  },
  scopedSetting: {
    findMany: async () => settingRows,
  },
}) as never

test('a personal account outranks the team and organisation ones', async () => {
  const resolved = await resolveConnectionForRun(
    fakePrisma(
      [connection('organization', 'org'), connection('team', 'team'), connection('user', 'mine')],
      [],
    ),
    { organizationId: 'org-1', requestedByUserId: 'user-1', teamId: 'team-1' },
  )
  assert.equal(resolved?.id, 'mine')
})

test('an organisation lock pins everyone to the organisation account', async () => {
  const resolved = await resolveConnectionForRun(
    fakePrisma(
      [connection('organization', 'org'), connection('team', 'team'), connection('user', 'mine')],
      [{ key: 'browser.connection', locked: true, scope: 'organization', value: null }],
    ),
    { organizationId: 'org-1', requestedByUserId: 'user-1', teamId: 'team-1' },
  )
  assert.equal(resolved?.id, 'org', 'the lock must beat the more specific account')
  assert.equal(resolved?.scope, 'organization')
})

test('a team lock pins the person to the team account but not the organisation', async () => {
  const resolved = await resolveConnectionForRun(
    fakePrisma(
      [connection('organization', 'org'), connection('team', 'team'), connection('user', 'mine')],
      [{ key: 'browser.connection', locked: true, scope: 'team', value: null }],
    ),
    { organizationId: 'org-1', requestedByUserId: 'user-1', teamId: 'team-1' },
  )
  assert.equal(resolved?.id, 'team')
})

test('an unattended run never reaches a personal account', async () => {
  const resolved = await resolveConnectionForRun(
    fakePrisma([connection('organization', 'org'), connection('user', 'mine')], []),
    { organizationId: 'org-1', requestedByUserId: null, teamId: null },
  )
  assert.equal(resolved?.id, 'org', 'a schedule must not spend an individual’s browser-hours')
})

test('no account anywhere resolves to null', async () => {
  const resolved = await resolveConnectionForRun(
    fakePrisma([], []),
    { organizationId: 'org-1', requestedByUserId: 'user-1', teamId: 'team-1' },
  )
  assert.equal(resolved, null)
})
