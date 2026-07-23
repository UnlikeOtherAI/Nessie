import assert from 'node:assert/strict'
import test from 'node:test'

import { TenantStore } from './tenant-store.js'

/**
 * Guards the guard: proves the fake datastore actually *returns* seeded rows and
 * applies `where` clauses faithfully. Without this, a bug that made every query
 * return empty would turn the whole conformance suite vacuously green.
 */
test('findFirst honours a scalar where and returns the matching row', async () => {
  const store = new TenantStore()
  store.seed('channel', [
    { id: 'a', organizationId: 'orgA' },
    { id: 'b', organizationId: 'orgB' },
  ])
  const prisma = store.client as unknown as {
    channel: {
      findFirst: (a: unknown) => Promise<{ id: string } | null>
      count: (a: unknown) => Promise<number>
    }
  }

  assert.equal((await prisma.channel.findFirst({ where: { id: 'a' } }))?.id, 'a')
  // A correctly-scoped query for orgA cannot see orgB's row...
  assert.equal(await prisma.channel.findFirst({ where: { id: 'b', organizationId: 'orgA' } }), null)
  // ...but the row DOES exist and would leak if the scope were dropped.
  assert.equal((await prisma.channel.findFirst({ where: { id: 'b' } }))?.id, 'b')
  assert.equal(await prisma.channel.count({ where: { organizationId: 'orgA' } }), 1)
})

test('findMany scoped by organizationId excludes foreign rows', async () => {
  const store = new TenantStore()
  store.seed('agent', [
    { id: '1', organizationId: 'orgA' },
    { id: '2', organizationId: 'orgB' },
    { id: '3', organizationId: 'orgB' },
  ])
  const prisma = store.client as unknown as {
    agent: { findMany: (a: unknown) => Promise<Array<{ id: string }>> }
  }
  const rows = await prisma.agent.findMany({ where: { organizationId: 'orgB' } })
  assert.deepEqual(rows.map((r) => r.id).sort(), ['2', '3'])
})

test('operators (in / not / gt) and to-one relation filters resolve', async () => {
  const store = new TenantStore()
  store.seed('channel', [{ id: 'c1', organizationId: 'orgA' }])
  store.seed('channelMember', [
    { id: 'm1', channelId: 'c1', userId: 'u1' },
    { id: 'm2', channelId: 'c1', userId: 'u2' },
  ])
  const prisma = store.client as unknown as {
    channelMember: { findFirst: (a: unknown) => Promise<{ id: string } | null> }
  }
  // channel.is.organizationId resolves the FK channelId -> channel.organizationId.
  assert.equal(
    (
      await prisma.channelMember.findFirst({
        where: { channelId: 'c1', userId: 'u1', channel: { is: { organizationId: 'orgA' } } },
      })
    )?.id,
    'm1',
  )
  // Wrong org via the relation filter matches nothing.
  assert.equal(
    await prisma.channelMember.findFirst({
      where: { channelId: 'c1', userId: 'u1', channel: { is: { organizationId: 'orgB' } } },
    }),
    null,
  )
})

test('updateMany / delete only touch matching rows', async () => {
  const store = new TenantStore()
  const rows = store.seed('trigger', [
    { id: 't1', organizationId: 'orgA', status: 'active' },
    { id: 't2', organizationId: 'orgB', status: 'active' },
  ])
  const prisma = store.client as unknown as {
    trigger: {
      updateMany: (a: unknown) => Promise<{ count: number }>
      deleteMany: (a: unknown) => Promise<{ count: number }>
    }
  }
  const updated = await prisma.trigger.updateMany({
    where: { organizationId: 'orgB' },
    data: { status: 'paused' },
  })
  assert.equal(updated.count, 1)
  assert.equal(rows.find((r) => r['id'] === 't1')?.['status'], 'active')
  assert.equal(rows.find((r) => r['id'] === 't2')?.['status'], 'paused')

  const deleted = await prisma.trigger.deleteMany({ where: { organizationId: 'orgA' } })
  assert.equal(deleted.count, 1)
  assert.equal(rows.length, 1)
})
