import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { UserAlertRecordSchema } from '@nessie/schemas'

import { listUserAlerts } from '../src/services/alerts.js'

// Plan §10.9: a budget alert is a bell row, so the owner reads which budget,
// what happened and how far along — named by the scope's current name, since
// a team renamed after the alert is still the same team.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('the bell reads a budget alert with its budget, kind and current scope name', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `budget bell ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `budget bell project ${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'Design', projectId: project.id } })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `budget-bell-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const marker = await prisma.budgetAlert.create({
    data: {
      kind: 'blocked',
      organizationId: organization.id,
      percentUsed: 104,
      period: 'weekly',
      periodStart: new Date('2026-09-21T00:00:00Z'),
      scopeId: team.id,
      scopeType: 'team',
    },
  })
  await prisma.userAlert.create({
    data: {
      budgetAlertId: marker.id,
      eventKey: `budget-alert:team:${team.id}:2026-09-21T00:00:00.000Z:blocked`,
      kind: 'budget_alert',
      organizationId: organization.id,
      userId: owner.id,
    },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  await prisma.team.update({ where: { id: team.id }, data: { name: 'Product design' } })
  const page = await listUserAlerts(prisma, { organizationId: organization.id, userId: owner.id })

  assert.equal(page.data.length, 1)
  const [alert] = page.data
  assert.equal(alert?.kind, 'budget_alert')
  assert.deepEqual(alert?.budgetAlert, {
    kind: 'blocked',
    percentUsed: 104,
    period: 'weekly',
    scopeName: 'Product design',
    scopeType: 'team',
  })
  // What the route parses on the way out.
  assert.doesNotThrow(() => UserAlertRecordSchema.parse(alert))
})
