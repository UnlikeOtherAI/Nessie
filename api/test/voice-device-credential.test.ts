import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'

import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import {
  hashVoiceCredential,
  isVoiceCredentialToken,
  mintVoiceDeviceCredential,
  revokeVoiceDeviceCredentials,
  rotateVoiceDeviceCredential,
  verifyVoiceDeviceCredential,
  VOICE_CREDENTIAL_PREFIX,
} from '../src/services/voice/voice-device-credential.js'

/**
 * The credential that lets a locked phone stay on a call.
 *
 * It is the one place the Expo shell's "the native app never sees an
 * authenticated Nessie token" rule is amended, so what is worth testing is not
 * that it works — it is everything it must *stop* doing: reaching routes it was
 * not scoped to, and outliving the sign-in, the membership or the device it was
 * derived from. Those are checked against a real database, because every one of
 * them is a row somewhere.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

test('the credential is recognisable without being verified', () => {
  // The auth hook has to pick a verifier before it can trust anything, so the
  // discriminator lives in the token's shape. A session JWT is three
  // dot-joined base64url segments and cannot collide with this.
  assert.ok(isVoiceCredentialToken(`${VOICE_CREDENTIAL_PREFIX}abc`))
  assert.equal(isVoiceCredentialToken('eyJhbGciOi.eyJzdWIi.c2ln'), false)
  assert.equal(isVoiceCredentialToken(''), false)
})

test('the token is never recoverable from what is stored', () => {
  const digest = hashVoiceCredential(`${VOICE_CREDENTIAL_PREFIX}secret`)
  assert.match(digest, /^[0-9a-f]{64}$/u)
  assert.ok(!digest.includes('secret'))
})

type Seeded = {
  installationId: string
  organizationId: string
  projectId: string
  sessionId: string
  teamId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seeded> => {
  const organizationId = randomUUID()
  const userId = randomUUID()
  const sessionId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `voice-cred ${organizationId}` },
  })
  await prisma.user.create({
    data: { displayName: 'Ondrej', email: `caller-${userId}@voice.test`, id: userId },
  })
  await prisma.organizationMember.create({ data: { organizationId, role: 'owner', userId } })
  const project = await prisma.project.create({ data: { name: 'P', organizationId } })
  const team = await prisma.team.create({ data: { name: 'T', projectId: project.id } })
  const installation = await prisma.voiceInstallation.create({
    data: { organizationId, platform: 'ios', userId },
  })
  // The sign-in the credential derives from. Without a live refresh row the
  // session reads as logged out, which is exactly one of the cases below.
  await prisma.refreshToken.create({
    data: {
      expiresAt: new Date(Date.now() + 86_400_000),
      familyId: randomUUID(),
      providerId: 'local',
      providerType: 'password',
      sessionId,
      tokenHash: `hash-${sessionId}`,
      userId,
    },
  })

  return {
    installationId: installation.id,
    organizationId,
    projectId: project.id,
    sessionId,
    teamId: team.id,
    userId,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seeded): Promise<void> => {
  await prisma.refreshToken.deleteMany({ where: { userId: seeded.userId } })
  await prisma.voiceDeviceCredential.deleteMany({
    where: { organizationId: seeded.organizationId },
  })
  await prisma.voiceInstallation.deleteMany({ where: { organizationId: seeded.organizationId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId: seeded.organizationId } })
  await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => undefined)
  await prisma.user.delete({ where: { id: seeded.userId } }).catch(() => undefined)
}

const withSeed = async (run: (prisma: PrismaClient, seeded: Seeded) => Promise<void>) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await run(prisma, seeded)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
}

dbTest('a minted credential authenticates as its own person, in its own team', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, {
      ...seeded,
      tokenVersion: 0,
    })

    const verified = await verifyVoiceDeviceCredential(prisma, token)
    assert.ok(verified.ok)
    assert.equal(verified.actorContext.actor.actorId, seeded.userId)
    assert.equal(verified.actorContext.actor.actorType, 'user')
    // Read from the live membership, so a demotion lands on the next request.
    assert.deepEqual(verified.actorContext.actor.roles, ['owner'])
    // Cost attribution is scoped by project and team; a credential provisioned
    // in one team must not bill another.
    assert.equal(verified.actorContext.tenant.organizationId, seeded.organizationId)
    assert.equal(verified.actorContext.tenant.projectId, seeded.projectId)
    assert.equal(verified.actorContext.tenant.teamId, seeded.teamId)
  })
})

dbTest('signing out on the web ends the call credential in someone’s pocket', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    assert.ok((await verifyVoiceDeviceCredential(prisma, token)).ok)

    // Logout revokes the exact session rather than the whole user generation.
    await prisma.refreshToken.updateMany({
      data: { revokedAt: new Date() },
      where: { sessionId: seeded.sessionId },
    })

    const after = await verifyVoiceDeviceCredential(prisma, token)
    assert.equal(after.ok, false)
    // "Sign me out everywhere" has to mean everywhere, including the call.
    assert.equal(after.ok === false && after.code, 'VOICE_CREDENTIAL_REVOKED')
  })
})

dbTest('a forced sign-out of every session ends it too', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    // The generation bump that invalidates every access token at once.
    await prisma.user.update({ data: { tokenVersion: 1 }, where: { id: seeded.userId } })

    const after = await verifyVoiceDeviceCredential(prisma, token)
    assert.equal(after.ok === false && after.code, 'VOICE_CREDENTIAL_REVOKED')
  })
})

dbTest('deactivating the member ends it', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    await prisma.organizationMember.update({
      data: { deactivatedAt: new Date() },
      where: {
        organizationId_userId: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
        },
      },
    })

    const after = await verifyVoiceDeviceCredential(prisma, token)
    assert.equal(after.ok === false && after.code, 'VOICE_CREDENTIAL_REVOKED')
  })
})

dbTest('revoking the device ends it', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    assert.equal(await revokeVoiceDeviceCredentials(prisma, seeded.installationId), 1)

    const after = await verifyVoiceDeviceCredential(prisma, token)
    assert.equal(after.ok === false && after.code, 'VOICE_CREDENTIAL_REVOKED')
  })
})

dbTest('minting again retires the token left on the old install', async () => {
  await withSeed(async (prisma, seeded) => {
    const first = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    const second = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })

    assert.equal((await verifyVoiceDeviceCredential(prisma, first.token)).ok, false)
    assert.ok((await verifyVoiceDeviceCredential(prisma, second.token)).ok)
  })
})

dbTest('rotation retires the credential it came from, and only once', async () => {
  await withSeed(async (prisma, seeded) => {
    const minted = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    const rotated = await rotateVoiceDeviceCredential(prisma, minted.credential)

    assert.notEqual(rotated.token, minted.token)
    assert.equal((await verifyVoiceDeviceCredential(prisma, minted.token)).ok, false)
    assert.ok((await verifyVoiceDeviceCredential(prisma, rotated.token)).ok)
    // Rotation carries the sign-in forward rather than deriving a new one, so
    // refreshing can never launder a credential past a sign-out.
    assert.equal(rotated.credential.sessionId, minted.credential.sessionId)

    // Two refreshes racing must not leave two live credentials behind.
    await assert.rejects(rotateVoiceDeviceCredential(prisma, minted.credential))
  })
})

dbTest('an expired credential is refused as expired, not as invalid', async () => {
  await withSeed(async (prisma, seeded) => {
    const minted = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    await prisma.voiceDeviceCredential.update({
      data: { expiresAt: new Date(Date.now() - 1_000) },
      where: { id: minted.credential.id },
    })

    const after = await verifyVoiceDeviceCredential(prisma, minted.token)
    // The native client acts differently on each: expired means refresh,
    // revoked means stop and re-provision from the WebView.
    assert.equal(after.ok === false && after.code, 'VOICE_CREDENTIAL_EXPIRED')
  })
})

/**
 * The scope, which is the whole security claim.
 *
 * Nessie has no generic route-scoping machinery, so "this credential only
 * reaches the voice routes" is enforced in one hook against a per-route flag.
 * If that ever stops holding, a stolen phone token reads the whole API — so it
 * is tested against a real route table rather than by reading the flag back.
 */
const appWithRoutes = async (prisma: PrismaClient) => {
  const app = Fastify()
  registerGlobalAuthHook(app, {
    // Never reached by these cases: a voice credential is resolved before the
    // session verifier, and an unauthenticated request never gets that far.
    authenticateRequest: async () => null,
    checkRateLimit: () => null,
    prisma,
  } as never)
  app.post('/api/voice/sessions/:id/usage', { config: { voiceCredential: true } }, async () => ({
    reached: 'voice',
  }))
  app.post('/api/threads/:id/messages', async () => ({ reached: 'generic' }))
  await app.ready()
  return app
}

dbTest('the credential reaches a call route and nothing else', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    const app = await appWithRoutes(prisma)
    try {
      const allowed = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        url: '/api/voice/sessions/abc/usage',
      })
      assert.equal(allowed.statusCode, 200)

      // The generic message route is the one the browser client uses today,
      // and the one a phone token must never reach: it would be an
      // unrestricted write to any thread the person can see.
      const refused = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        url: '/api/threads/abc/messages',
      })
      assert.equal(refused.statusCode, 403)
      assert.equal(refused.json().error.code, 'VOICE_CREDENTIAL_OUT_OF_SCOPE')
    } finally {
      await app.close()
    }
  })
})

dbTest('a revoked credential is refused even on a route it was scoped to', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    await revokeVoiceDeviceCredentials(prisma, seeded.installationId)
    const app = await appWithRoutes(prisma)
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        url: '/api/voice/sessions/abc/usage',
      })
      assert.equal(response.statusCode, 401)
      assert.equal(response.json().error.code, 'VOICE_CREDENTIAL_REVOKED')
    } finally {
      await app.close()
    }
  })
})

dbTest('a device credential cannot mint another one', async () => {
  await withSeed(async (prisma, seeded) => {
    const { token } = await mintVoiceDeviceCredential(prisma, { ...seeded, tokenVersion: 0 })
    const app = Fastify()
    registerGlobalAuthHook(app, {
      authenticateRequest: async () => null,
      checkRateLimit: () => null,
      prisma,
    } as never)
    // Registered exactly as the real one is: no voice-credential marker.
    app.post('/api/voice/device-token', async () => ({ minted: true }))
    await app.ready()
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        url: '/api/voice/device-token',
      })
      // A credential that could mint its successor from scratch would outlive
      // the sign-out that should have ended it. Renewal is the rotate route.
      assert.equal(response.statusCode, 403)
      assert.equal(response.json().error.code, 'VOICE_CREDENTIAL_OUT_OF_SCOPE')
    } finally {
      await app.close()
    }
  })
})
