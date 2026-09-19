import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardSharePublicationRecordSelect,
  mapBoardSharePublicationRecord,
  mapResourceSharePersistenceRecord,
  presentResourceShare,
  resourceShareRecordSelect,
  type BoardSharePublicationRecordRow,
  type ResourceShareRecordRow,
} from '../src/resource-share-records.js'

const IDS = {
  share: '11111111-1111-4111-8111-111111111111',
  sourceOrg: '22222222-2222-4222-8222-222222222222',
  sourceTeam: '33333333-3333-4333-8333-333333333333',
  project: '44444444-4444-4444-8444-444444444444',
  board: '55555555-5555-4555-8555-555555555555',
  recipientOrg: '66666666-6666-4666-8666-666666666666',
  recipientTeam: '77777777-7777-4777-8777-777777777777',
  field: '88888888-8888-4888-8888-888888888888',
  iteration: '99999999-9999-4999-8999-999999999999',
  page: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const

const NOW = new Date('2026-09-19T10:00:00.000Z')

const activeBoardRow = (): ResourceShareRecordRow => ({
  id: IDS.share,
  scope: 'board',
  sourceOrganizationId: IDS.sourceOrg,
  sourceExternalOrgId: 'uoa-org-source',
  sourceTeamId: IDS.sourceTeam,
  sourceExternalTeamId: 'uoa-team-source',
  projectId: IDS.project,
  targetBoardId: IDS.board,
  boardId: IDS.board,
  recipientOrganizationId: IDS.recipientOrg,
  recipientExternalOrgId: 'uoa-org-recipient',
  recipientTeamId: IDS.recipientTeam,
  recipientExternalTeamId: 'uoa-team-recipient',
  proposedAccess: 'read',
  proposedRevision: 2,
  effectiveAccess: 'read',
  effectiveRevision: 2,
  status: 'active',
  revision: 2,
  expiresAt: null,
  createdBySubject: 'uoa-sub-source-manager',
  createdByActingOrgRef: 'uoa-org-source',
  acceptedBySubject: 'uoa-sub-recipient-manager',
  acceptedByActingOrgRef: 'uoa-org-recipient',
  acceptedAt: NOW,
  declinedBySubject: null,
  declinedByActingOrgRef: null,
  declinedAt: null,
  revokedBySubject: null,
  revokedByActingOrgRef: null,
  revokedAt: null,
  expiredAt: null,
  health: 'healthy',
  healthReasonCode: null,
  healthRevision: 1,
  healthTransitionedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
})

const publicationRow = (): BoardSharePublicationRecordRow => ({
  boardId: IDS.board,
  projectId: IDS.project,
  sourceOrganizationId: IDS.sourceOrg,
  revision: 4,
  fields: [{ fieldDefinitionId: IDS.field, allowedOptionIds: ['option-a'] }],
  iterations: [{ iterationId: IDS.iteration }],
  resources: [{ pageId: IDS.page }],
  createdAt: NOW,
  updatedAt: NOW,
})

test('resource share select contains exactly the strict record fields', () => {
  assert.deepEqual(Object.keys(resourceShareRecordSelect).sort(), [
    'acceptedAt',
    'acceptedByActingOrgRef',
    'acceptedBySubject',
    'boardId',
    'createdAt',
    'createdByActingOrgRef',
    'createdBySubject',
    'declinedAt',
    'declinedByActingOrgRef',
    'declinedBySubject',
    'effectiveAccess',
    'effectiveRevision',
    'expiredAt',
    'expiresAt',
    'health',
    'healthReasonCode',
    'healthRevision',
    'healthTransitionedAt',
    'id',
    'projectId',
    'proposedAccess',
    'proposedRevision',
    'recipientExternalOrgId',
    'recipientExternalTeamId',
    'recipientOrganizationId',
    'recipientTeamId',
    'revision',
    'revokedAt',
    'revokedByActingOrgRef',
    'revokedBySubject',
    'scope',
    'sourceExternalOrgId',
    'sourceExternalTeamId',
    'sourceOrganizationId',
    'sourceTeamId',
    'status',
    'targetBoardId',
    'updatedAt',
  ])
})

test('resource share mapping validates exact rows and terminal board audit', () => {
  const active = mapResourceSharePersistenceRecord(activeBoardRow())
  assert.equal(active.createdAt, NOW.toISOString())

  const terminal = mapResourceSharePersistenceRecord({
    ...activeBoardRow(),
    boardId: null,
    status: 'revoked',
    revokedBySubject: 'uoa-sub-source-manager',
    revokedByActingOrgRef: 'uoa-org-source',
    revokedAt: NOW,
  })
  assert.equal(terminal.targetBoardId, IDS.board)
  assert.equal(terminal.boardId, null)
})

test('resource share mapping rejects omitted, unexpected and invalid fields', () => {
  const omitted: Partial<ResourceShareRecordRow> = { ...activeBoardRow() }
  delete omitted.projectId
  assert.throws(() => mapResourceSharePersistenceRecord(omitted as ResourceShareRecordRow))

  assert.throws(() => mapResourceSharePersistenceRecord({
    ...activeBoardRow(),
    recipientTeamName: 'Copied UOA label',
  } as unknown as ResourceShareRecordRow))

  assert.throws(() => mapResourceSharePersistenceRecord({
    ...activeBoardRow(),
    effectiveAccess: null,
    effectiveRevision: null,
  }))
})

test('viewer presentation excludes every persistence and cross-tenant identity field', () => {
  const view = presentResourceShare(activeBoardRow(), {
    accept: false,
    decline: false,
    revoke: true,
  })
  assert.deepEqual(view, {
    capabilities: { accept: false, decline: false, revoke: true },
    effectiveAccess: 'read',
    expiresAt: null,
    health: 'healthy',
    healthReasonCode: null,
    healthRevision: 1,
    id: IDS.share,
    proposedAccess: 'read',
    revision: 2,
    scope: 'board',
    status: 'active',
  })
  for (const privateField of [
    'sourceOrganizationId',
    'sourceExternalOrgId',
    'sourceTeamId',
    'sourceExternalTeamId',
    'projectId',
    'targetBoardId',
    'boardId',
    'recipientOrganizationId',
    'recipientExternalOrgId',
    'recipientTeamId',
    'recipientExternalTeamId',
    'createdBySubject',
    'acceptedBySubject',
    'revokedBySubject',
  ]) assert.equal(privateField in view, false)
})

test('publication select is exact and orders every child collection', () => {
  assert.deepEqual(boardSharePublicationRecordSelect, {
    boardId: true,
    projectId: true,
    sourceOrganizationId: true,
    revision: true,
    fields: {
      orderBy: { fieldDefinitionId: 'asc' },
      select: { fieldDefinitionId: true, allowedOptionIds: true },
    },
    iterations: {
      orderBy: { iterationId: 'asc' },
      select: { iterationId: true },
    },
    resources: {
      orderBy: { pageId: 'asc' },
      select: { pageId: true },
    },
    createdAt: true,
    updatedAt: true,
  })
})

test('publication mapping validates exact root and child rows', () => {
  const publication = mapBoardSharePublicationRecord(publicationRow())
  assert.equal(publication.createdAt, NOW.toISOString())
  assert.deepEqual(publication.fields, [{
    fieldDefinitionId: IDS.field,
    allowedOptionIds: ['option-a'],
  }])

  const omitted: Partial<BoardSharePublicationRecordRow> = { ...publicationRow() }
  delete omitted.projectId
  assert.throws(() => mapBoardSharePublicationRecord(
    omitted as BoardSharePublicationRecordRow,
  ))

  assert.throws(() => mapBoardSharePublicationRecord({
    ...publicationRow(),
    recipientOverrides: [],
  } as unknown as BoardSharePublicationRecordRow))

  assert.throws(() => mapBoardSharePublicationRecord({
    ...publicationRow(),
    fields: [{
      fieldDefinitionId: IDS.field,
      allowedOptionIds: [''],
    }],
  }))
})
