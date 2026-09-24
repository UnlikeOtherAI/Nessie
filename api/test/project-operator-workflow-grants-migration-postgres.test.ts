import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

/**
 * `20260924120100_project_operator_workflow_grants`, run against rows seeded
 * the way agents hold workflow tools today
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability").
 *
 * The migration is one `DO` block over every agent row, and it only ever adds
 * a key an agent does not have, so running it again here is running it on
 * exactly these rows. Assertions are scoped to this suite's own organisation.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const migrationSql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260924120100_project_operator_workflow_grants/migration.sql',
), 'utf8')

const WORKFLOW_WRITES = ['workflow_create', 'workflow_update', 'workflow_install', 'workflow_trigger_create', 'workflow_run']

test('the migration covers exactly the workflow verbs that moved behind the operator arm', () => {
  const moved = BUILTIN_TOOL_DEFINITIONS
    .filter((tool) => tool.category === 'workflows' || tool.id.startsWith('workflow_'))
    .filter((tool) => tool.projectOperator === true)
    .map((tool) => tool.id)
    .sort()
  assert.deepEqual(moved, [...WORKFLOW_WRITES].sort())
  for (const id of WORKFLOW_WRITES) assert.match(migrationSql, new RegExp(`'${id}'`), id)
})

runDatabaseTest('agents that allow a workflow verb are granted project_operator, and nobody else is', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `operator-grants ${suffix}` } })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.$disconnect()
  })
  const agent = (name: string, toolPolicy: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
    prisma.agent.create({
      data: { name, organizationId: organization.id, role: 'assistant', toolPolicy, visibility: 'team', ...extra },
      select: { id: true },
    })
  const builder = await agent('Builder', { workflow_create: true, web_search: true })
  const runner = await agent('Runner', { workflow_run: true, workflow_install: false })
  const denied = await agent('Denied', { workflow_create: false })
  const plain = await agent('Plain', {})
  const refused = await agent('Refused', { project_operator: false, workflow_trigger_create: true })
  const gone = await agent('Gone', { workflow_create: true }, { deletedAt: new Date() })
  const system = await agent('System', { workflow_create: true }, { systemManaged: true, systemSlug: `system-${suffix}` })

  await prisma.$executeRawUnsafe(migrationSql)

  const policyOf = async (id: string) =>
    (await prisma.agent.findUniqueOrThrow({ where: { id }, select: { toolPolicy: true } })).toolPolicy
  // Granted explicitly, every other verdict kept as it was.
  assert.deepEqual(await policyOf(builder.id), { project_operator: true, web_search: true, workflow_create: true })
  assert.deepEqual(await policyOf(runner.id), { project_operator: true, workflow_install: false, workflow_run: true })
  // An explicit false, the default, an existing verdict on the grant itself, a
  // deleted agent and a system agent are all left alone.
  assert.deepEqual(await policyOf(denied.id), { workflow_create: false })
  assert.deepEqual(await policyOf(plain.id), {})
  assert.deepEqual(await policyOf(refused.id), { project_operator: false, workflow_trigger_create: true })
  assert.deepEqual(await policyOf(gone.id), { workflow_create: true })
  assert.deepEqual(await policyOf(system.id), { workflow_create: true })

  // Idempotent: a second run changes nothing.
  await prisma.$executeRawUnsafe(migrationSql)
  assert.deepEqual(await policyOf(builder.id), { project_operator: true, web_search: true, workflow_create: true })
})
