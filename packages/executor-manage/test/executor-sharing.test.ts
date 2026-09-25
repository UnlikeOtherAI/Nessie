import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  canReadExecutorStatus, getExecutorForManagement, getExecutorSharing, listExecutorsForProject,
  listVisibleExecutors, resolveExecutorAvailabilityCandidates, updateExecutorSharing,
} from '../src/index.js'
import { leaseTestPrisma, seedLeaseWorld, LOCAL_APPS } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('sharing grants use by team or project, administration only explicitly or to shared-team admins', async () => {
  const prisma = leaseTestPrisma()
  const world = await seedLeaseWorld(prisma, { scope: 'private' })
  const team = await prisma.team.findFirstOrThrow({ where: { projectId: world.projectId } })
  const foreignProject = await prisma.project.create({ data: { organizationId: world.organizationId, name: 'Other team project' } })
  try {
    await prisma.project.update({ where: { id: world.projectId }, data: { teamId: team.id } })
    await prisma.teamMember.createMany({ data: [
      { teamId: team.id, userId: world.adminId, role: 'owner' },
      { teamId: team.id, userId: world.holderId, role: 'admin' },
      { teamId: team.id, userId: world.memberId, role: 'member' },
    ] })
    await prisma.executorPrivateAssignment.deleteMany({
      where: { executorId: world.executorId, userId: world.holderId },
    })
    const visible = async (userId: string) => (await listVisibleExecutors(prisma, world.contextFor(userId)))
      .some((executor) => executor.id === world.executorId)
    const manage = (userId: string) => getExecutorForManagement(prisma, world.contextFor(userId), world.executorId)
    const change = (value: Parameters<typeof updateExecutorSharing>[2]['change']) => updateExecutorSharing(
      prisma, world.adminContext, { executorId: world.executorId, teamId: team.id, change: value },
    )
    const available = (projectId?: string) => resolveExecutorAvailabilityCandidates(prisma, world.memberContext, {
      agentId: world.agentId, operationKeys: LOCAL_APPS, ...(projectId ? { projectId } : {}),
    })
    assert.equal(await visible(world.memberId), false)
    assert.equal(await manage(world.holderId), null, 'team admin cannot inspect an unshared machine')
    await change({ kind: 'person', userId: world.memberId, role: 'use' })
    assert.equal(await visible(world.memberId), true)
    assert.equal(await manage(world.memberId), null)
    await change({ kind: 'person', userId: world.memberId, role: 'admin' })
    assert.ok(await manage(world.memberId))
    await change({ kind: 'person', userId: world.memberId, role: null })
    assert.equal(await visible(world.memberId), false)
    await assert.rejects(change({ kind: 'person', userId: world.adminId, role: 'use' }))
    await assert.rejects(change({ kind: 'person', userId: randomUUID(), role: 'admin' }))
    await assert.rejects(change({ kind: 'project', projectId: foreignProject.id, enabled: true }))
    await prisma.projectMember.create({ data: { projectId: world.projectId, userId: world.memberId, role: 'owner' } })
    await change({ kind: 'project', projectId: world.projectId, enabled: true })
    assert.equal(await visible(world.memberId), true)
    assert.equal(await manage(world.memberId), null, 'project role never grants machine administration')
    assert.ok(await manage(world.holderId), 'team administrator sees the shared machine')
    assert.equal((await listExecutorsForProject(prisma, world.memberContext, world.projectId)).length, 1)
    assert.equal((await listExecutorsForProject(prisma, world.memberContext, foreignProject.id)).length, 0)
    assert.equal(await canReadExecutorStatus(prisma, { executorId: world.executorId,
      organizationId: world.organizationId, userId: world.memberId }), true)
    assert.equal((await available(world.projectId)).candidates.length, 1)
    assert.equal((await available()).candidates.length, 0, 'project grant does not authorize unrelated work')
    await prisma.project.update({ where: { id: world.projectId }, data: { visibility: 'protected' } })
    const sharing = await getExecutorSharing(prisma, world.adminContext, world.executorId, team.id)
    assert.equal(sharing.ownerUserId, world.adminId)
    assert.deepEqual(sharing.projects, [{ projectId: world.projectId, name: 'Private project' }])
    await change({ kind: 'project', projectId: world.projectId, enabled: false })
    assert.equal(await visible(world.memberId), false)
    await change({ kind: 'team', enabled: true })
    assert.equal((await available()).candidates.length, 1)
    assert.equal(await manage(world.memberId), null)
    await prisma.teamMember.delete({ where: { teamId_userId: { teamId: team.id, userId: world.memberId } } })
    assert.equal((await available()).candidates.length, 0, 'departed members lose use without stale ACL copies')
    assert.equal(await canReadExecutorStatus(prisma, { executorId: world.executorId,
      organizationId: world.organizationId, userId: world.memberId }), false)
    await change({ kind: 'team', enabled: false })
    assert.equal(await manage(world.holderId), null)
  } finally {
    await prisma.project.delete({ where: { id: foreignProject.id } })
    await prisma.project.update({ where: { id: world.projectId }, data: { teamId: null } })
    await world.cleanup()
    await prisma.$disconnect()
  }
})
