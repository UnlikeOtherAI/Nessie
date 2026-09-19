import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BoardSharePublicationRecordSchema,
  ResourceShareRecordSchema,
  ResourceShareStateTransitionSchema,
  ResourceShareViewSchema,
} from '../resource-shares.js'

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

const NOW = '2026-09-19T10:00:00.000Z'
const LATER = '2026-09-19T11:00:00.000Z'

const activeBoardShare = () => ({
  id: IDS.share,
  scope: 'board' as const,
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
  proposedAccess: 'read' as const,
  proposedRevision: 2,
  effectiveAccess: 'read' as const,
  effectiveRevision: 2,
  status: 'active' as const,
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
  health: 'healthy' as const,
  healthReasonCode: null,
  healthRevision: 1,
  healthTransitionedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
})

test('resource share accepts active access and a pending read-to-write widening', () => {
  assert.equal(ResourceShareRecordSchema.safeParse(activeBoardShare()).success, true)

  const widening = {
    ...activeBoardShare(),
    proposedAccess: 'write' as const,
    proposedRevision: 3,
    revision: 3,
  }
  assert.equal(ResourceShareRecordSchema.safeParse(widening).success, true)
})

test('resource share closes scope, tenant and lifecycle invariants', () => {
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    scope: 'project',
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    boardId: null,
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    targetBoardId: IDS.recipientTeam,
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    recipientExternalOrgId: 'uoa-org-source',
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    status: 'pending',
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    proposedAccess: 'read',
    effectiveAccess: 'write',
  }).success, false)
})

test('terminal board audit survives loss of the live board relation', () => {
  const terminal = {
    ...activeBoardShare(),
    boardId: null,
    status: 'revoked' as const,
    revokedBySubject: 'uoa-sub-source-manager',
    revokedByActingOrgRef: 'uoa-org-source',
    revokedAt: NOW,
  }
  assert.equal(ResourceShareRecordSchema.safeParse(terminal).success, true)
})

test('resource share transitions keep identity, target, audience and creation audit immutable', () => {
  const previous = activeBoardShare()
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: { ...previous, revision: 3 },
  }).success, true)
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: {
      ...previous,
      recipientTeamId: IDS.sourceTeam,
      revision: 3,
    },
  }).success, false)
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: {
      ...previous,
      targetBoardId: IDS.recipientTeam,
      boardId: IDS.recipientTeam,
      revision: 3,
    },
  }).success, false)
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: { ...previous, createdBySubject: 'another-subject', revision: 3 },
  }).success, false)
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: { ...previous, createdAt: LATER, revision: 3 },
  }).success, false)
})

test('resource share transitions keep terminal audit append-only', () => {
  const revoked = {
    ...activeBoardShare(),
    status: 'revoked' as const,
    revokedBySubject: 'uoa-sub-source-manager',
    revokedByActingOrgRef: 'uoa-org-source',
    revokedAt: NOW,
  }
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous: revoked,
    next: { ...revoked, revokedBySubject: 'another-subject', revision: 3 },
  }).success, false)

  const declined = {
    ...activeBoardShare(),
    effectiveAccess: null,
    effectiveRevision: null,
    acceptedBySubject: null,
    acceptedByActingOrgRef: null,
    acceptedAt: null,
    status: 'declined' as const,
    declinedBySubject: 'uoa-sub-recipient-manager',
    declinedByActingOrgRef: 'uoa-org-recipient',
    declinedAt: NOW,
  }
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous: declined,
    next: { ...declined, declinedAt: LATER, revision: 3 },
  }).success, false)

  const expired = {
    ...activeBoardShare(),
    status: 'expired' as const,
    expiredAt: NOW,
  }
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous: expired,
    next: { ...expired, expiredAt: LATER, revision: 3 },
  }).success, false)
})

test('acceptance audit changes require a newly effective revision', () => {
  const previous = activeBoardShare()
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: {
      ...previous,
      acceptedBySubject: 'new-acceptor',
      acceptedAt: LATER,
      revision: 3,
    },
  }).success, false)
  assert.equal(ResourceShareStateTransitionSchema.safeParse({
    previous,
    next: {
      ...previous,
      proposedAccess: 'write',
      proposedRevision: 3,
      effectiveAccess: 'write',
      effectiveRevision: 3,
      acceptedBySubject: 'new-acceptor',
      acceptedAt: LATER,
      revision: 3,
    },
  }).success, true)
})

test('resource share requires complete stable actor references and health reason state', () => {
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    acceptedBySubject: null,
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    health: 'suspended',
    healthReasonCode: null,
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    health: 'suspended',
    healthReasonCode: 'recipient_entitlement_unavailable',
  }).success, true)
})

test('resource share record refuses unknown identity or commercial fields', () => {
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    recipientTeamName: 'Copied UOA label',
  }).success, false)
  assert.equal(ResourceShareRecordSchema.safeParse({
    ...activeBoardShare(),
    subscriptionPlan: 'enterprise',
  }).success, false)
})

test('resource share views refuse persistence ids and UOA actor references', () => {
  const view = {
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
  }
  assert.equal(ResourceShareViewSchema.safeParse(view).success, true)
  assert.equal(ResourceShareViewSchema.safeParse({
    ...view,
    sourceOrganizationId: IDS.sourceOrg,
  }).success, false)
  assert.equal(ResourceShareViewSchema.safeParse({
    ...view,
    acceptedBySubject: 'uoa-sub-recipient-manager',
  }).success, false)
})

test('board publication accepts explicit fields, iterations and page roots', () => {
  assert.equal(BoardSharePublicationRecordSchema.safeParse({
    boardId: IDS.board,
    projectId: IDS.project,
    sourceOrganizationId: IDS.sourceOrg,
    revision: 4,
    fields: [{ fieldDefinitionId: IDS.field, allowedOptionIds: ['option-a'] }],
    iterations: [{ iterationId: IDS.iteration }],
    resources: [{ pageId: IDS.page }],
    createdAt: NOW,
    updatedAt: NOW,
  }).success, true)
})

test('board publication refuses duplicate option ids and unknown projection fields', () => {
  const base = {
    boardId: IDS.board,
    projectId: IDS.project,
    sourceOrganizationId: IDS.sourceOrg,
    revision: 4,
    fields: [{ fieldDefinitionId: IDS.field, allowedOptionIds: ['same', 'same'] }],
    iterations: [],
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
  assert.equal(BoardSharePublicationRecordSchema.safeParse(base).success, false)
  assert.equal(BoardSharePublicationRecordSchema.safeParse({
    ...base,
    fields: [],
    recipientOverrides: [],
  }).success, false)
})
