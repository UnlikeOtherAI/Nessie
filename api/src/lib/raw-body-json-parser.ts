import type { FastifyInstance } from 'fastify'

import type { RequestWithRawBody } from './server-context.js'

/**
 * The JSON body parser that keeps the received bytes on `request.rawBody`.
 *
 * Every signature-verifying intake — the signed trigger webhook, the Slack and
 * Google comms webhooks, the inbound agent mail relay — must hash the bytes it
 * was sent, not a re-serialisation of the parsed object.
 *
 * It lives in its own module, imported by `buildApp` and by the test that
 * proves the contract, so that test does not have to pull the whole
 * composition root (and everything it wires) into its process to register one
 * parser. It has no runtime imports of its own.
 */
export const registerRawBodyJsonParser = (app: FastifyInstance): void => {
  // Fastify's built-in exact-match parser for `application/json` outranks any
  // regexp parser, so without this removal the parser below never ran for the
  // one content type every webhook actually sends: `request.rawBody` stayed
  // unset, `POST /api/triggers/:triggerId/webhook` could not verify an HMAC
  // over the bytes it received and answered 401 to every correctly signed
  // delivery, and the comms webhooks hashed a re-serialised body (2026-09-05
  // review). Removal must come first — Fastify refuses a duplicate
  // registration for a content type it already has.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json($|;)/i,
    { parseAs: 'buffer' },
    (request, body, done) => {
      ;(request as RequestWithRawBody).rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body)

      if (body.length === 0) {
        done(null, null)
        return
      }

      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (error) {
        done(error as Error)
      }
    },
  )
}
