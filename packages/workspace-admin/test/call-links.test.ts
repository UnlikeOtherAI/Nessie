import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ConnectorConnectionContext } from '@nessie/comms-connect'

import {
  CallLinkError,
  CommsCredentialCoordinatorError,
  createCallLinkForTeamUser,
  type CreateCallLinkDependencies,
} from '../src/index.js'

const TEAM_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000003'

const googleCredential: ConnectorConnectionContext = {
  id: '00000000-0000-4000-8000-000000000004',
  organizationId: ORGANIZATION_ID,
  ownerUserId: USER_ID,
  provider: 'google',
  externalTenantId: 'person@example.com',
  externalUserId: 'person@example.com',
  credential: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['https://www.googleapis.com/auth/meetings.space.created'],
  },
}

const fakePrisma = (callProvider = 'google_meet'): PrismaClient => ({
  team: {
    findUnique: async () => ({
      callProvider,
      project: { organizationId: ORGANIZATION_ID },
    }),
  },
  organizationMember: {
    findFirst: async () => ({ id: 'membership-1' }),
  },
  commsConnection: {
    updateMany: async () => ({ count: 1 }),
  },
} as unknown as PrismaClient)

const baseDependencies = (): CreateCallLinkDependencies => ({
  encryptionSecret: 'encryption-secret',
  env: {
    NESSIE_COMMS_GOOGLE_CLIENT_ID: 'client-id',
    NESSIE_COMMS_GOOGLE_CLIENT_SECRET: 'client-secret',
  },
  loadGoogleCredential: async () => googleCredential,
  createGoogleMeeting: async () => 'https://meet.google.com/abc-defg-hij',
})

test('dispatches Google Meet through the selected user credential', async () => {
  let receivedAccessToken: string | undefined
  const result = await createCallLinkForTeamUser(
    fakePrisma(),
    { teamId: TEAM_ID, userId: USER_ID },
    {
      ...baseDependencies(),
      createGoogleMeeting: async (accessToken) => {
        receivedAccessToken = accessToken
        return 'https://meet.google.com/abc-defg-hij'
      },
    },
  )

  assert.equal(receivedAccessToken, 'access-token')
  assert.deepEqual(result, {
    provider: 'google_meet',
    meetingUri: 'https://meet.google.com/abc-defg-hij',
  })
})

test('dispatches Jitsi without loading a Google credential', async () => {
  let loadedGoogle = false
  const result = await createCallLinkForTeamUser(
    fakePrisma('jitsi'),
    { teamId: TEAM_ID, userId: USER_ID },
    {
      ...baseDependencies(),
      env: { NESSIE_JITSI_DOMAIN: 'jitsi.example.com' },
      randomBytes: () => new Uint8Array(16),
      loadGoogleCredential: async () => {
        loadedGoogle = true
        return googleCredential
      },
    },
  )

  assert.equal(loadedGoogle, false)
  assert.deepEqual(result, {
    provider: 'jitsi',
    meetingUri: 'https://jitsi.example.com/nessie-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
})

test('Microsoft Teams is a typed unconfigured provider', async () => {
  await assert.rejects(
    createCallLinkForTeamUser(
      fakePrisma('microsoft_teams'),
      { teamId: TEAM_ID, userId: USER_ID },
      baseDependencies(),
    ),
    (error: unknown) => error instanceof CallLinkError
      && error.code === 'PROVIDER_NOT_CONFIGURED',
  )
})

const credentialErrorCases = [
  ['CONNECTION_NOT_FOUND', 'GOOGLE_NOT_CONNECTED'],
  ['SCOPE_MISSING', 'MEET_SCOPE_MISSING'],
  ['NEEDS_REAUTHORIZATION', 'GOOGLE_REAUTH_REQUIRED'],
] as const

for (const [credentialCode, callLinkCode] of credentialErrorCases) {
  test(`maps ${credentialCode} to ${callLinkCode}`, async () => {
    await assert.rejects(
      createCallLinkForTeamUser(
        fakePrisma(),
        { teamId: TEAM_ID, userId: USER_ID },
        {
          ...baseDependencies(),
          loadGoogleCredential: async () => {
            throw new CommsCredentialCoordinatorError(credentialCode)
          },
        },
      ),
      (error: unknown) => error instanceof CallLinkError
        && error.code === callLinkCode,
    )
  })
}

test('maps a Meet provider failure to MEET_LINK_FAILED', async () => {
  await assert.rejects(
    createCallLinkForTeamUser(
      fakePrisma(),
      { teamId: TEAM_ID, userId: USER_ID },
      {
        ...baseDependencies(),
        createGoogleMeeting: async () => {
          throw new Error('provider unavailable')
        },
      },
    ),
    (error: unknown) => error instanceof CallLinkError
      && error.code === 'MEET_LINK_FAILED',
  )
})
