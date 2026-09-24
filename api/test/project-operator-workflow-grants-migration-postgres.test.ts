import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import pg from 'pg'

/**
 * `20260924120100_project_operator_workflow_grants`, run against rows seeded
 * the way agents hold workflow tools today
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability").
 *
 * The migration is one `DO` block over every agent row, and it only ever adds
 * a key an agent does not have, so running it again here is running it on
 * exactly these rows. It runs through a plain `pg` client so the WARNING lines
 * it names each agent in can be read; assertions are scoped to this suite's
 * own organisation.
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

const runMigration = async (): Promise<string[]> => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  const warnings: string[] = []
  client.on('notice', (notice) => {
    if (notice.severity === 'WARNING') warnings.push(notice.message ?? '')
  })
  await client.connect()
  try {
    await client.query(migrationSql)
  } finally {
    await client.end()
  }
  return warnings
}

runDatabaseTest('agents that allow a workflow verb are granted project_operator, and nobody else is', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `operator-grants ${suffix}` } })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.$disconnect()
  })
  const project = await prisma.project.create({ data: { name: `p-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const room = await prisma.channel.create({
    data: { label: 'eng', organizationId: organization.id, projectId: project.id, slug: `eng-${suffix}`, teamId: team.id },
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
  const child = await agent('Child', { workflow_create: true }, { parentAgentId: builder.id })
  // Builder works in a project room and fires on a cron; Runner is in none.
  await prisma.agentBinding.create({ data: { agentId: builder.id, channelId: room.id } })
  await prisma.agentTrigger.create({
    data: {
      agentId: builder.id, config: { cron: '0 9 * * *', timezone: 'UTC' }, name: 'Daily', targetChannelId: room.id,
      type: 'scheduled',
    },
  })

  const warnings = (await runMigration()).filter((line) => line.includes(organization.id))

  const policyOf = async (id: string) =>
    (await prisma.agent.findUniqueOrThrow({ where: { id }, select: { toolPolicy: true } })).toolPolicy
  // Granted explicitly, every other verdict kept as it was.
  assert.deepEqual(await policyOf(builder.id), { project_operator: true, web_search: true, workflow_create: true })
  assert.deepEqual(await policyOf(runner.id), { project_operator: true, workflow_install: false, workflow_run: true })
  // An explicit false, the default, an existing verdict on the grant itself, a
  // deleted agent, a system agent and a spawned child are all left alone.
  assert.deepEqual(await policyOf(denied.id), { workflow_create: false })
  assert.deepEqual(await policyOf(plain.id), {})
  assert.deepEqual(await policyOf(refused.id), { project_operator: false, workflow_trigger_create: true })
  assert.deepEqual(await policyOf(gone.id), { workflow_create: true })
  assert.deepEqual(await policyOf(system.id), { workflow_create: true })
  assert.deepEqual(await policyOf(child.id), { workflow_create: true })

  // Each grant is named, saying access narrows and what else it opens.
  const granted = warnings.filter((line) => line.includes('was granted project_operator'))
  assert.equal(granted.length, 2)
  for (const [name, id] of [['Builder', builder.id], ['Runner', runner.id]] as const) {
    const line = granted.find((entry) => entry.includes(id))
    assert.ok(line, name)
    assert.match(line, new RegExp(`^agent "${name}" `))
    assert.match(line, /keeps them only on a person's own turn in a project channel it is in/)
    assert.match(line, /also opens project, team, channel, board, document space and trigger setup/)
  }
  // And whose workflow use it narrows today: Builder's cron, Runner's lack of a room.
  const narrowed = warnings.filter((line) => line.includes('no longer reaches'))
  assert.equal(narrowed.length, 2)
  assert.match(narrowed.find((line) => line.includes(builder.id)) ?? '', /its enabled scheduled trigger fires lose them$/)
  assert.match(narrowed.find((line) => line.includes(runner.id)) ?? '', /it is in no project channel, so no turn opens them$/)

  // Idempotent: a second run changes nothing and names nobody.
  const again = (await runMigration()).filter((line) => line.includes(organization.id))
  assert.deepEqual(again, [])
  assert.deepEqual(await policyOf(builder.id), { project_operator: true, web_search: true, workflow_create: true })
})
