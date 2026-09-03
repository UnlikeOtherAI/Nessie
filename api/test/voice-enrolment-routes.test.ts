import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerVoiceEnrolmentRoutes } from '../src/routes/voice-enrolment.js'
import { registerVoiceRoutes } from '../src/routes/voice.js'

/**
 * Enrolment moved out of `voice.ts` into its own module when the route file
 * crossed the 500-line cap. Nothing covered those three endpoints, so the
 * refactor could have dropped one silently — a registrar that is written but
 * never called compiles perfectly.
 *
 * The assertion is therefore the registered route table itself: the voice
 * subsystem's one entry point must still answer on every path its
 * authorization matrix lists.
 */

/**
 * Collected through `onRoute` rather than by parsing `printRoutes`, whose
 * output is a display tree that folds a parameter segment onto its own line —
 * the first version of this test read `/api/voice/installations` twice and
 * lost the `:installationId` route it was written to protect.
 */
const routePaths = async (
  register: (app: ReturnType<typeof Fastify>) => void,
): Promise<string[]> => {
  const app = Fastify()
  const paths = new Set<string>()
  app.addHook('onRoute', (route) => {
    paths.add(route.url)
  })
  register(app)
  await app.ready()
  await app.close()
  return [...paths].sort()
}

// Only what the enrolment routes reach; a handler is never invoked here.
const enrolmentDeps = {
  prisma: {},
  requireActorContext: () => null,
} as never

test('the voice subsystem still registers every route in its authorization matrix', async () => {
  const paths = await routePaths((app) => {
    registerVoiceRoutes(app, {
      ...(enrolmentDeps as object),
      authSecret: 'test',
      fileService: {},
      ledgerIdentity: null,
      loadPersonalAssistantState: async () => null,
      requireUserActor: () => false,
    } as never)
  })

  assert.deepEqual(paths, [
    '/api/voice/capability',
    '/api/voice/device-token',
    '/api/voice/device-token/refresh',
    '/api/voice/installations',
    '/api/voice/installations/:installationId',
    '/api/voice/sessions',
    '/api/voice/sessions/:sessionId/end',
    '/api/voice/sessions/:sessionId/rotate',
    '/api/voice/sessions/:sessionId/tool-call',
    '/api/voice/sessions/:sessionId/transcript',
    '/api/voice/sessions/:sessionId/usage',
  ])
})

test('enrolment registers on its own, so the split is a real seam rather than a re-export', async () => {
  const paths = await routePaths((app) => registerVoiceEnrolmentRoutes(app, enrolmentDeps))
  assert.deepEqual(paths, [
    '/api/voice/capability',
    '/api/voice/device-token',
    '/api/voice/device-token/refresh',
    '/api/voice/installations',
    '/api/voice/installations/:installationId',
  ])
})
