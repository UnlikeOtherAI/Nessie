import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveTeamProject } from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const legacyProjectId = '00000000-0000-4000-8000-000000000003'
const canonicalOneId = '00000000-0000-4000-8000-000000000004'
const canonicalTwoId = '00000000-0000-4000-8000-000000000005'
const teamId = '00000000-0000-4000-8000-000000000006'

const prismaFor = (
  canonical: { id: string; organizationId: string }[],
  requestedTeamId: string | null = null,
) => ({
  team: {
    findUnique: async ({ where, select }: {
      where: { id: string }
      select: { projects: { where: { id: string } } }
    }) => where.id === teamId
      ? {
          project: { id: legacyProjectId, organizationId },
          projects: canonical.filter((project) => project.id === select.projects.where.id),
        }
      : null,
  },
  project: {
    findUnique: async () => ({ teamId: requestedTeamId }),
  },
}) as unknown as PrismaClient

test('resolves either of two canonical projects for one team only when selected', async () => {
  const prisma = prismaFor([
    { id: canonicalOneId, organizationId },
    { id: canonicalTwoId, organizationId },
  ])

  const selected = await resolveTeamProject(prisma, {
    organizationId,
    projectId: canonicalTwoId,
    teamId,
  })

  assert.deepEqual(selected, { organizationId, projectId: canonicalTwoId, teamId })
})

test('keeps a legacy project reachable alongside canonical projects', async () => {
  const selected = await resolveTeamProject(prismaFor([{ id: canonicalOneId, organizationId }]), {
    organizationId,
    projectId: legacyProjectId,
    teamId,
  })

  assert.deepEqual(selected, { organizationId, projectId: legacyProjectId, teamId })
})

test('refuses a project from another tenant even when its id is named', async () => {
  const selected = await resolveTeamProject(prismaFor([
    { id: canonicalOneId, organizationId: otherOrganizationId },
  ]), {
    organizationId,
    projectId: canonicalOneId,
    teamId,
  })

  assert.equal(selected, null)
})

test('refuses an unselected project rather than choosing an ambient project', async () => {
  const selected = await resolveTeamProject(prismaFor([{ id: canonicalOneId, organizationId }]), {
    organizationId,
    projectId: canonicalTwoId,
    teamId,
  })

  assert.equal(selected, null)
})

test('refuses a legacy fallback when another team canonically owns the project', async () => {
  const selected = await resolveTeamProject(
    prismaFor([], '00000000-0000-4000-8000-000000000007'),
    { organizationId, projectId: legacyProjectId, teamId },
  )

  assert.equal(selected, null)
})
