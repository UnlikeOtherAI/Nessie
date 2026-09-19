import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  resolveResourceAccess,
  type ResourceAccessActor,
  type ResourceAccessInput,
  type ResourceShareAuthorityDependencies,
} from '../src/resource-share-authority.js'

const NOW = new Date('2026-09-19T12:00:00.000Z')

const IDS = {
  board: '11111111-1111-4111-8111-111111111111',
  recipientOrg: '22222222-2222-4222-8222-222222222222',
  recipientTeam: '33333333-3333-4333-8333-333333333333',
  share: '44444444-4444-4444-8444-444444444444',
  sourceOrg: '55555555-5555-4555-8555-555555555555',
  sourceTeam: '66666666-6666-4666-8666-666666666666',
  project: '77777777-7777-4777-8777-777777777777',
  user: '88888888-8888-4888-8888-888888888888',
} as const

const actor = (organizationId = IDS.recipientOrg): ResourceAccessActor => ({
  isOrganizationAdmin: true,
  organizationId,
  uoaIdentity: {
    organizationId: organizationId === IDS.recipientOrg ? 'uoa-recipient' : 'uoa-source',
    subject: 'uoa-subject',
    teamId: 'uoa-recipient-team',
    tokenVersion: 7,
  },
  userId: IDS.user,
})

const boardInput = (overrides: Partial<ResourceAccessInput> = {}): ResourceAccessInput => ({
  action: 'read',
  actor: actor(),
  shareId: IDS.share,
  target: {
    boardId: IDS.board,
    kind: 'board',
    projectId: IDS.project,
    sourceOrganizationId: IDS.sourceOrg,
  },
  ...overrides,
})

const activeBoardShare = () => ({
  boardId: IDS.board,
  effectiveAccess: 'read' as const,
  effectiveRevision: 2,
  expiresAt: null,
  health: 'healthy' as const,
  id: IDS.share,
  projectId: IDS.project,
  recipientOrganizationId: IDS.recipientOrg,
  recipientTeamId: IDS.recipientTeam,
  revision: 2,
  scope: 'board' as const,
  sourceOrganizationId: IDS.sourceOrg,
  sourceTeamId: IDS.sourceTeam,
  status: 'active' as const,
  targetBoardId: IDS.board,
})

type FakeRows = {
  board?: { id: string } | null
  project?: {
    channelRoot: boolean
    deletedAt: Date | null
    organizationId: string
    teamId: string | null
  } | null
  publication?: {
    fields: { allowedOptionIds: string[]; fieldDefinitionId: string }[]
    iterations: { iterationId: string }[]
    resources: { pageId: string }[]
    revision: number
  } | null
  share?: Record<string, unknown> | null
}

const fakePrisma = (rows: FakeRows = {}): PrismaClient => ({
  board: {
    findFirst: async () => rows.board === undefined ? { id: IDS.board } : rows.board,
  },
  boardSharePublication: {
    findUnique: async () => rows.publication === undefined
      ? {
          fields: [{ allowedOptionIds: ['option-a'], fieldDefinitionId: 'field-a' }],
          iterations: [{ iterationId: 'iteration-a' }],
          resources: [{ pageId: 'page-a' }],
          revision: 4,
        }
      : rows.publication,
  },
  project: {
    findUnique: async () => rows.project === undefined
      ? {
          channelRoot: false,
          deletedAt: null,
          organizationId: IDS.sourceOrg,
          teamId: IDS.sourceTeam,
        }
      : rows.project,
  },
  resourceShare: {
    findUnique: async () => rows.share === undefined ? activeBoardShare() : rows.share,
  },
} as unknown as PrismaClient)

const sharedDeps = (
  overrides: ResourceShareAuthorityDependencies = {},
): ResourceShareAuthorityDependencies => ({
  isSharingEnabled: () => true,
  isSharingPolicyEligible: async () => true,
  now: () => NOW,
  resolveLiveRecipientEntitlements: async () => ({
    kind: 'uoa',
    organizationId: IDS.recipientOrg,
    organizationRole: 'owner',
    teamIds: [IDS.recipientTeam],
    userId: IDS.user,
  }),
  ...overrides,
})

test('native authority runs only inside the actor tenant and preserves read-only public reach', async () => {
  let nativeReadCalls = 0
  const result = await resolveResourceAccess(
    fakePrisma({
      project: {
        channelRoot: true,
        deletedAt: null,
        organizationId: IDS.sourceOrg,
        teamId: IDS.sourceTeam,
      },
    }),
    boardInput({ actor: actor(IDS.sourceOrg), shareId: undefined }),
    {
      canModifyNativeProject: async () => false,
      resolveNativeProjectAccess: async () => {
        nativeReadCalls += 1
        return 'full'
      },
    },
  )
  assert.equal(nativeReadCalls, 1)
  assert.deepEqual(result, {
    kind: 'native',
    level: 'full',
    operations: ['read'],
    target: boardInput().target,
  })
})

test('a recipient organization admin never inherits source-native authority', async () => {
  let nativeCalls = 0
  const result = await resolveResourceAccess(fakePrisma(), boardInput(), {
    canModifyNativeProject: async () => {
      nativeCalls += 1
      return true
    },
    resolveNativeProjectAccess: async () => {
      nativeCalls += 1
      return 'full'
    },
  })
  assert.equal(nativeCalls, 0)
  assert.deepEqual(result, { kind: 'denied', reason: 'sharing_disabled' })
})

test('foreign access requires an explicit share context before live entitlement work', async () => {
  let entitlementCalls = 0
  const result = await resolveResourceAccess(
    fakePrisma(),
    boardInput({ shareId: undefined }),
    sharedDeps({
      resolveLiveRecipientEntitlements: async () => {
        entitlementCalls += 1
        return { kind: 'denied' }
      },
    }),
  )
  assert.equal(entitlementCalls, 0)
  assert.deepEqual(result, { kind: 'denied', reason: 'share_context_required' })
})

test('a complete board grant returns one exact authority and publication revision', async () => {
  const result = await resolveResourceAccess(fakePrisma(), boardInput(), sharedDeps())
  assert.equal(result.kind, 'shared')
  if (result.kind !== 'shared') return
  assert.deepEqual(result.operations, ['read'])
  assert.equal(result.actor.organizationId, IDS.recipientOrg)
  assert.equal(result.actor.recipientTeamId, IDS.recipientTeam)
  assert.equal(result.actor.credentialEpoch, 7)
  assert.equal(result.source.organizationId, IDS.sourceOrg)
  assert.equal(result.source.teamId, IDS.sourceTeam)
  assert.equal(result.grant.id, IDS.share)
  assert.equal(result.grant.revision, 2)
  assert.deepEqual(result.publication, {
    fieldDefinitions: [{ allowedOptionIds: ['option-a'], fieldDefinitionId: 'field-a' }],
    iterations: ['iteration-a'],
    resources: ['page-a'],
    revision: 4,
  })
})

test('recipient team proof, grant mode, expiry and policy each fail closed', async () => {
  const wrongTeam = await resolveResourceAccess(
    fakePrisma(),
    boardInput(),
    sharedDeps({
      resolveLiveRecipientEntitlements: async () => ({
        kind: 'uoa',
        organizationId: IDS.recipientOrg,
        organizationRole: 'owner',
        teamIds: [],
        userId: IDS.user,
      }),
    }),
  )
  assert.equal(wrongTeam.kind, 'denied')

  const wrongActorProof = await resolveResourceAccess(
    fakePrisma(),
    boardInput(),
    sharedDeps({
      resolveLiveRecipientEntitlements: async () => ({
        kind: 'uoa',
        organizationId: IDS.recipientOrg,
        organizationRole: 'owner',
        teamIds: [IDS.recipientTeam],
        userId: '99999999-9999-4999-8999-999999999999',
      }),
    }),
  )
  assert.equal(wrongActorProof.kind, 'denied')

  const writeOnRead = await resolveResourceAccess(
    fakePrisma(),
    boardInput({ action: 'write' }),
    sharedDeps(),
  )
  assert.equal(writeOnRead.kind, 'denied')

  const expired = await resolveResourceAccess(
    fakePrisma({ share: { ...activeBoardShare(), expiresAt: NOW } }),
    boardInput(),
    sharedDeps(),
  )
  assert.equal(expired.kind, 'denied')

  const policyDenied = await resolveResourceAccess(
    fakePrisma(),
    boardInput(),
    sharedDeps({ isSharingPolicyEligible: async () => false }),
  )
  assert.equal(policyDenied.kind, 'denied')

  const recipientAdminManage = await resolveResourceAccess(
    fakePrisma(),
    boardInput({ action: 'manage' }),
    sharedDeps(),
  )
  assert.equal(recipientAdminManage.kind, 'denied')
})

test('scope and live ancestry must agree with the qualified target', async () => {
  const wrongBoard = await resolveResourceAccess(
    fakePrisma({
      share: {
        ...activeBoardShare(),
        boardId: '99999999-9999-4999-8999-999999999999',
        targetBoardId: '99999999-9999-4999-8999-999999999999',
      },
    }),
    boardInput(),
    sharedDeps(),
  )
  assert.equal(wrongBoard.kind, 'denied')

  const boardShareForProject = await resolveResourceAccess(
    fakePrisma(),
    boardInput({
      target: {
        kind: 'project',
        projectId: IDS.project,
        sourceOrganizationId: IDS.sourceOrg,
      },
    }),
    sharedDeps(),
  )
  assert.equal(boardShareForProject.kind, 'denied')
})

test('a project grant can authorize its exact board without borrowing a board policy', async () => {
  const share = {
    ...activeBoardShare(),
    boardId: null,
    scope: 'project' as const,
    targetBoardId: null,
  }
  const result = await resolveResourceAccess(
    fakePrisma({ publication: null, share }),
    boardInput(),
    sharedDeps(),
  )
  assert.equal(result.kind, 'shared')
  if (result.kind === 'shared') assert.equal(result.publication, null)
})
