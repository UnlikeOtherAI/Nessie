import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

/**
 * `request.rawBody` for an exact `application/json` request (2026-09-05 review).
 *
 * The API registered a regexp content-type parser to capture the unparsed
 * bytes, but Fastify's built-in **exact-match** parser for `application/json`
 * outranks a regexp one — so for the single content type every webhook
 * actually sends, the regexp parser never ran. `rawBody` stayed undefined,
 * which meant `POST /api/triggers/:triggerId/webhook` could not verify an HMAC
 * over the bytes it received and answered 401 to every correctly signed
 * delivery, and the comms webhooks silently hashed a re-serialised body.
 *
 * Both halves are pinned here: the real parser (`registerRawBodyJsonParser`,
 * the one `buildApp` installs) hands the route the exact bytes and the signed
 * webhook authenticates; the same regexp parser registered WITHOUT removing
 * the built-in — the wiring that shipped — leaves `rawBody` unset and 401s the
 * identical request.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const { registerRawBodyJsonParser } = await import('../src/lib/raw-body-json-parser.js')
const { registerTriggerIntakeRoutes } = await import('../src/routes/trigger-intake.js')

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer }

const SIGNING_SECRET = 'raw-body-signing-secret'

const seedSignedWebhookTrigger = async (prisma: PrismaClient): Promise<string> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `raw-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `raw-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `raw-${suffix}`, projectId: project.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `raw-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'webhook',
      config: {},
      signingSecret: SIGNING_SECRET,
    },
  })
  return trigger.id
}

/**
 * The pre-fix wiring, reproduced exactly: the same regexp parser, registered
 * without first removing Fastify's built-in `application/json` parser. Nothing
 * about it is wrong on its own — that is the point. The built-in simply wins.
 */
const registerRegexpParserWithoutRemovingBuiltin = (app: FastifyInstance): void => {
  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json($|;)/i,
    { parseAs: 'buffer' },
    (request, body, done) => {
      ;(request as RawBodyRequest).rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body)
      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (error) {
        done(error as Error)
      }
    },
  )
}

const buildIntakeApp = async (
  prisma: PrismaClient,
  registerParser: (app: FastifyInstance) => void,
) => {
  const app = Fastify({ logger: false })
  registerParser(app)
  const seenRawBodies: Array<Buffer | undefined> = []
  app.addHook('preHandler', async (request) => {
    seenRawBodies.push((request as RawBodyRequest).rawBody)
  })
  registerTriggerIntakeRoutes(app, {
    prisma,
    requireActorContext: () => null,
    requireOwner: () => false,
    readWebhookApiKey: () => undefined,
    isJsonContentType: (request: FastifyRequest) =>
      /^application\/([a-z0-9.+-]+\+)?json($|;)/i.test(
        String(request.headers['content-type'] ?? ''),
      ),
    readFirstHeader: () => undefined,
  } as never)
  await app.ready()
  return { app, seenRawBodies }
}

const PAYLOAD = JSON.stringify({ event: 'ping', nested: { spacing: 'matters' } })

const fireSigned = (
  app: FastifyInstance,
  triggerId: string,
) => app.inject({
  method: 'POST',
  url: `/api/triggers/${triggerId}/webhook`,
  headers: {
    'content-type': 'application/json',
    'x-nessie-signature': `sha256=${
      createHmac('sha256', SIGNING_SECRET).update(Buffer.from(PAYLOAD, 'utf8')).digest('hex')
    }`,
  },
  payload: PAYLOAD,
})

dbTest('the real parser hands the route the bytes it received, and the signature verifies', async () => {
  const prisma = new PrismaClient()
  try {
    const triggerId = await seedSignedWebhookTrigger(prisma)
    const { app, seenRawBodies } = await buildIntakeApp(prisma, registerRawBodyJsonParser)

    const response = await fireSigned(app, triggerId)

    // Past the signature gate: the trigger's agent is bound to no channel, so
    // dispatch refuses with 409 — which is precisely the proof that the HMAC
    // was verified rather than rejected.
    assert.notEqual(response.statusCode, 401)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, 'AGENT_NOT_BOUND')

    assert.equal(seenRawBodies.length, 1)
    assert.ok(seenRawBodies[0], 'rawBody must be captured for exact application/json')
    assert.equal(seenRawBodies[0]?.toString('utf8'), PAYLOAD)
    assert.ok(seenRawBodies[0]?.equals(Buffer.from(PAYLOAD, 'utf8')))

    await app.close()
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('without removing the built-in parser the identical signed request 401s', async () => {
  const prisma = new PrismaClient()
  try {
    const triggerId = await seedSignedWebhookTrigger(prisma)
    const { app, seenRawBodies } = await buildIntakeApp(
      prisma,
      registerRegexpParserWithoutRemovingBuiltin,
    )

    const response = await fireSigned(app, triggerId)

    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error.code, 'WEBHOOK_SIGNATURE_INVALID')
    assert.equal(seenRawBodies.length, 1)
    assert.equal(seenRawBodies[0], undefined)

    await app.close()
  } finally {
    await prisma.$disconnect()
  }
})
