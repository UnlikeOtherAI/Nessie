import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerVoiceEnrolmentRoutes } from '../src/routes/voice-enrolment.js'
import { registerVoiceRoutes } from '../src/routes/voice.js'

/**
 * `voice.ts` keeps shedding modules as it meets the 500-line cap — enrolment
 * first, then the conversation bridge and the call record. Nothing covered
 * those endpoints, so a split could have dropped one silently: a registrar
 * that is written but never called compiles perfectly.
 *
 * The assertion is therefore the registered route table itself: the voice
 * subsystem's one entry point must still answer on every path its
 * authorization matrix lists, and each row must carry the credential scope its
 * matrix column claims. A missing `voiceCredential` marker is invisible from
 * the browser and locks a phone out of the middle of a call.
 */

/**
 * Collected through `onRoute` rather than by parsing `printRoutes`, whose
 * output is a display tree that folds a parameter segment onto its own line —
 * the first version of this test read `/api/voice/installations` twice and
 * lost the `:installationId` route it was written to protect.
 */
const routeTable = async (
  register: (app: ReturnType<typeof Fastify>) => void,
): Promise<{ duringACall: string[]; paths: string[] }> => {
  const app = Fastify()
  const paths = new Set<string>()
  const duringACall = new Set<string>()
  app.addHook('onRoute', (route) => {
    paths.add(route.url)
    if ((route.config as { voiceCredential?: boolean } | undefined)?.voiceCredential === true) {
      duringACall.add(`${route.method as string} ${route.url}`)
    }
  })
  register(app)
  await app.ready()
  await app.close()
  return { duringACall: [...duringACall].sort(), paths: [...paths].sort() }
}

// Only what the enrolment routes reach; a handler is never invoked here.
const enrolmentDeps = {
  prisma: {},
  requireActorContext: () => null,
} as never

test('the voice subsystem still registers every route in its authorization matrix', async () => {
  const { duringACall, paths } = await routeTable((app) => {
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
    '/api/voice/sessions/:sessionId/pa-send',
    '/api/voice/sessions/:sessionId/replies',
    '/api/voice/sessions/:sessionId/rotate',
    '/api/voice/sessions/:sessionId/tool-call',
    '/api/voice/sessions/:sessionId/transcript',
    '/api/voice/sessions/:sessionId/usage',
    '/api/voice/transcriptions',
  ])

  // The `session, device` column of the matrix, as code. Enrolment is
  // deliberately absent: provisioning is the WebView's job on an ordinary
  // sign-in, and a credential that could mint its successor would outlive the
  // sign-out that should have ended it.
  assert.deepEqual(duringACall, [
    'GET /api/voice/sessions/:sessionId/replies',
    // Fastify registers HEAD alongside every GET; the scope must cover it too.
    'HEAD /api/voice/sessions/:sessionId/replies',
    'POST /api/voice/device-token/refresh',
    'POST /api/voice/sessions',
    'POST /api/voice/sessions/:sessionId/end',
    'POST /api/voice/sessions/:sessionId/pa-send',
    'POST /api/voice/sessions/:sessionId/rotate',
    'POST /api/voice/sessions/:sessionId/tool-call',
    'POST /api/voice/sessions/:sessionId/transcript',
    'POST /api/voice/sessions/:sessionId/usage',
  ])
})

test('enrolment registers on its own, so the split is a real seam rather than a re-export', async () => {
  const { paths } = await routeTable((app) => registerVoiceEnrolmentRoutes(app, enrolmentDeps))
  assert.deepEqual(paths, [
    '/api/voice/capability',
    '/api/voice/device-token',
    '/api/voice/device-token/refresh',
    '/api/voice/installations',
    '/api/voice/installations/:installationId',
  ])
})
