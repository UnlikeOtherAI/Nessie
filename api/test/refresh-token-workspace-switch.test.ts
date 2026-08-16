import assert from 'node:assert/strict'
import test from 'node:test'

import {
  consumeRefreshToken,
  hashRefreshToken,
  UoaRefreshBindingError,
  UoaWorkspaceSwitchError,
} from '../src/services/refresh-token.js'
import {
  AUTH_SECRET,
  consume,
  createRefreshFixture,
  defaultUoaRefresh,
  FakeRefreshTokenPrisma,
  SESSION_ID,
  TTL_SECONDS,
  UOA_IDENTITY,
  USER_ID,
  type RefreshCallback,
} from './refresh-token-fixture.js'

const createFixture = createRefreshFixture

const SWITCH_TARGET = {
  organizationId: 'uoa-org-two',
  teamId: 'uoa-team-two',
} as const

const switchWorkspace = (
  fake: FakeRefreshTokenPrisma,
  rawToken: string,
  now: Date,
  refreshUoaSession: RefreshCallback = defaultUoaRefresh(now),
  target = SWITCH_TARGET,
) => consumeRefreshToken(fake.asClient(), {
  authSecret: AUTH_SECRET,
  advanceUoaSessionBinding: async () => undefined,
  beforeUoaWorkspaceSwitch: async () => undefined,
  rawToken,
  refreshUoaSession,
  ttlSeconds: TTL_SECONDS,
  uoaWorkspaceSwitch: {
    sourceIdentity: UOA_IDENTITY,
    sourceProviderId: 'uoa',
    sourceSessionId: SESSION_ID,
    sourceUserId: USER_ID,
    target,
  },
  userAgent: 'Nessie test',
  now,
})

test('workspace switch binds one durable intent and atomically rescope-rotates both credentials', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let sawIntentBeforeIo = false
  let bindingAdvancedInTransaction = false

  const result = await consumeRefreshToken(fake.asClient(), {
    authSecret: AUTH_SECRET,
    advanceUoaSessionBinding: async () => {
      bindingAdvancedInTransaction = fake.activeTransactions === 1
    },
    beforeUoaWorkspaceSwitch: async () => {
      sawIntentBeforeIo = fake.uoaWorkspaceSwitchIntents.size === 1
        && fake.activeTransactions === 0
    },
    rawToken,
    refreshUoaSession: defaultUoaRefresh(now),
    ttlSeconds: TTL_SECONDS,
    uoaWorkspaceSwitch: {
      sourceIdentity: UOA_IDENTITY,
      sourceProviderId: 'uoa',
      sourceSessionId: SESSION_ID,
      sourceUserId: USER_ID,
      target: SWITCH_TARGET,
    },
    now,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(sawIntentBeforeIo, true)
  assert.equal(bindingAdvancedInTransaction, true)
  assert.deepEqual(result.uoaIdentity, { ...UOA_IDENTITY, ...SWITCH_TARGET })
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  const credential = fake.uoaCredentials.get(result.familyId)
  assert.equal(credential?.organizationId, SWITCH_TARGET.organizationId)
  assert.equal(credential?.teamId, SWITCH_TARGET.teamId)
  assert.equal(credential?.generation, 1)
})

test('ordinary refresh resumes an exact durable switch after local commit loss', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const refresh = defaultUoaRefresh(now)

  await assert.rejects(
    switchWorkspace(fake, rawToken, now, async (input) => {
      const result = await refresh(input)
      fake.failNextTransaction = true
      return result
    }),
    /simulated local commit failure/,
  )
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)

  let resumedTarget: unknown
  const resumed = await consume(
    fake,
    rawToken,
    new Date(now.getTime() + 1_000),
    async (input) => {
      resumedTarget = input.workspaceSwitch
      return refresh(input)
    },
  )
  assert.equal(resumed.ok, true)
  if (!resumed.ok) return
  assert.deepEqual(resumedTarget, SWITCH_TARGET)
  assert.deepEqual(resumed.uoaIdentity, { ...UOA_IDENTITY, ...SWITCH_TARGET })
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
})

test('ordinary refresh resumes after target materialization fails post-grant', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const refresh = defaultUoaRefresh(now)
  let upstreamSuccesses = 0

  await assert.rejects(
    switchWorkspace(fake, rawToken, now, async (input) => {
      const result = await refresh(input)
      upstreamSuccesses += 1
      throw new Error(`materialization failed after ${result.identity.teamId}`)
    }),
    /materialization failed after uoa-team-two/,
  )
  assert.equal(upstreamSuccesses, 1)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)

  let replayedTarget: unknown
  const resumed = await consume(
    fake,
    rawToken,
    new Date(now.getTime() + 1_000),
    async (input) => {
      replayedTarget = input.workspaceSwitch
      upstreamSuccesses += 1
      return refresh(input)
    },
  )
  assert.equal(resumed.ok, true)
  if (!resumed.ok) return
  assert.equal(upstreamSuccesses, 2)
  assert.deepEqual(replayedTarget, SWITCH_TARGET)
  assert.deepEqual(resumed.uoaIdentity, { ...UOA_IDENTITY, ...SWITCH_TARGET })
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
})

test('a resumed switch refusal is definitive because its upstream edge may be committed', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const refresh = defaultUoaRefresh(now)

  await assert.rejects(
    switchWorkspace(fake, rawToken, now, async (input) => {
      await refresh(input)
      throw new Error('local commit failed after upstream success')
    }),
    /local commit failed after upstream success/,
  )
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)

  await assert.rejects(
    consumeRefreshToken(fake.asClient(), {
      authSecret: AUTH_SECRET,
      advanceUoaSessionBinding: async () => undefined,
      beforeUoaWorkspaceSwitch: async () => {
        throw new UoaWorkspaceSwitchError(
          'WORKSPACE_NOT_AVAILABLE',
          'target access was removed',
          true,
        )
      },
      rawToken,
      refreshUoaSession: refresh,
      ttlSeconds: TTL_SECONDS,
    }),
    UoaRefreshBindingError,
  )
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
})

test('safe upstream switch refusal clears only the intent and preserves the source family', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  await assert.rejects(
    switchWorkspace(fake, rawToken, now, async () => {
      throw new UoaWorkspaceSwitchError(
        'WORKSPACE_NOT_AVAILABLE',
        'target unavailable',
        true,
      )
    }),
    (error: unknown) =>
      error instanceof UoaWorkspaceSwitchError
      && error.code === 'WORKSPACE_NOT_AVAILABLE',
  )
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
  assert.deepEqual(
    fake.uoaCredentials.values().next().value?.organizationId,
    UOA_IDENTITY.organizationId,
  )
})

test('a different target cannot replace a live family switch intent', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  await assert.rejects(
    switchWorkspace(fake, rawToken, now, async () => {
      throw new Error('temporary outage')
    }),
    /temporary outage/,
  )
  const original = fake.uoaWorkspaceSwitchIntents.values().next().value
  assert.deepEqual(
    [original?.targetOrganizationId, original?.targetTeamId],
    [SWITCH_TARGET.organizationId, SWITCH_TARGET.teamId],
  )

  await assert.rejects(
    switchWorkspace(fake, rawToken, now, undefined, {
      organizationId: 'other-org',
      teamId: 'other-team',
    }),
    (error: unknown) =>
      error instanceof UoaWorkspaceSwitchError
      && error.code === 'WORKSPACE_SWITCH_CONFLICT',
  )
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)
})

test('workspace switch preserves a healthy cookie when the bearer source is stale or unrelated', async () => {
  const { fake, rawToken } = await createFixture()
  let upstreamCalls = 0

  await assert.rejects(
    consumeRefreshToken(fake.asClient(), {
      authSecret: AUTH_SECRET,
      advanceUoaSessionBinding: async () => undefined,
      beforeUoaWorkspaceSwitch: async () => undefined,
      rawToken,
      refreshUoaSession: async (input) => {
        upstreamCalls += 1
        return defaultUoaRefresh(new Date())(input)
      },
      ttlSeconds: TTL_SECONDS,
      uoaWorkspaceSwitch: {
        sourceIdentity: UOA_IDENTITY,
        sourceProviderId: 'uoa',
        sourceSessionId: '00000000-0000-4000-8000-000000000099',
        sourceUserId: USER_ID,
        target: SWITCH_TARGET,
      },
    }),
    (error: unknown) =>
      error instanceof UoaWorkspaceSwitchError
      && error.code === 'WORKSPACE_SWITCH_CONFLICT',
  )
  assert.equal(upstreamCalls, 0)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
})

test('a stale source bearer cannot revoke a workspace-switch successor', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const switched = await switchWorkspace(fake, rawToken, now)
  assert.equal(switched.ok, true)
  if (!switched.ok) return

  let upstreamCalls = 0
  await assert.rejects(
    switchWorkspace(
      fake,
      switched.rawToken,
      new Date(now.getTime() + 1_000),
      async (input) => {
        upstreamCalls += 1
        return defaultUoaRefresh(now)(input)
      },
    ),
    (error: unknown) =>
      error instanceof UoaWorkspaceSwitchError
      && error.code === 'WORKSPACE_SWITCH_CONFLICT',
  )
  assert.equal(upstreamCalls, 0)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  assert.equal(
    fake.findByHash(hashRefreshToken(switched.rawToken))?.revokedAt,
    null,
  )

  const reconciled = await consume(
    fake,
    switched.rawToken,
    new Date(now.getTime() + 2_000),
  )
  assert.equal(reconciled.ok, true)
  if (reconciled.ok) {
    assert.deepEqual(reconciled.uoaIdentity, {
      ...UOA_IDENTITY,
      ...SWITCH_TARGET,
    })
  }
})

test('a stale bearer epoch is a non-revoking switch conflict', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const advanced = await consume(fake, rawToken, now, async (input) => ({
    identity: { ...input.expectedIdentity, tokenVersion: 8 },
    refreshToken: `${input.refreshToken}.next`,
    refreshTokenExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  }))
  assert.equal(advanced.ok, true)
  if (!advanced.ok) return

  let upstreamCalls = 0
  await assert.rejects(
    switchWorkspace(
      fake,
      advanced.rawToken,
      new Date(now.getTime() + 1_000),
      async (input) => {
        upstreamCalls += 1
        return defaultUoaRefresh(now)(input)
      },
    ),
    (error: unknown) =>
      error instanceof UoaWorkspaceSwitchError
      && error.code === 'WORKSPACE_SWITCH_CONFLICT',
  )
  assert.equal(upstreamCalls, 0)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  assert.equal(fake.findByHash(hashRefreshToken(advanced.rawToken))?.revokedAt, null)
})

test('workspace switch revalidates its exact source after access confirmation', async () => {
  const { fake, rawToken } = await createFixture()
  let upstreamCalls = 0

  await assert.rejects(
    consumeRefreshToken(fake.asClient(), {
      authSecret: AUTH_SECRET,
      advanceUoaSessionBinding: async () => undefined,
      beforeUoaWorkspaceSwitch: async () => {
        const credential = fake.uoaCredentials.values().next().value
        assert.ok(credential)
        credential.generation += 1
      },
      rawToken,
      refreshUoaSession: async (input) => {
        upstreamCalls += 1
        return defaultUoaRefresh(new Date())(input)
      },
      ttlSeconds: TTL_SECONDS,
      uoaWorkspaceSwitch: {
        sourceIdentity: UOA_IDENTITY,
        sourceProviderId: 'uoa',
        sourceSessionId: SESSION_ID,
        sourceUserId: USER_ID,
        target: SWITCH_TARGET,
      },
    }),
    UoaRefreshBindingError,
  )
  assert.equal(upstreamCalls, 0)
})

test('an ordinary same-scope winner adopts its successor and cancels a concurrent intent atomically', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let enterOrdinary!: () => void
  let releaseOrdinary!: () => void
  let enterSwitch!: () => void
  let releaseSwitch!: () => void
  const ordinaryEntered = new Promise<void>((resolve) => { enterOrdinary = resolve })
  const ordinaryGate = new Promise<void>((resolve) => { releaseOrdinary = resolve })
  const switchEntered = new Promise<void>((resolve) => { enterSwitch = resolve })
  const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve })
  const refresh = defaultUoaRefresh(now)

  const ordinary = consume(fake, rawToken, now, async (input) => {
    assert.equal(input.workspaceSwitch, undefined)
    enterOrdinary()
    await ordinaryGate
    return refresh(input)
  })
  await ordinaryEntered
  const switching = switchWorkspace(fake, rawToken, now, async () => {
    enterSwitch()
    await switchGate
    throw new UoaWorkspaceSwitchError(
      'WORKSPACE_SWITCH_CONFLICT',
      'ordinary child won upstream',
      true,
    )
  })
  await switchEntered
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 1)

  releaseOrdinary()
  const ordinaryResult = await ordinary
  assert.equal(ordinaryResult.ok, true)
  if (ordinaryResult.ok) assert.deepEqual(ordinaryResult.uoaIdentity, UOA_IDENTITY)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
  releaseSwitch()
  await assert.rejects(switching, UoaWorkspaceSwitchError)
  assert.equal(fake.uoaWorkspaceSwitchIntents.size, 0)
})
