import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { registerApiErrorHandler } from '../src/lib/error-handler.js'

const buildTestApp = () => {
  const app = Fastify({ logger: false })
  registerApiErrorHandler(app)

  app.get('/zod-error', () => {
    z.object({ name: z.string() }).parse({})
  })

  app.get('/bug', () => {
    throw new Error('a token abc123 leaked into this message')
  })

  app.get('/fastify-client-error', () => {
    const error = Object.assign(new Error('Unsupported Media Type: application/xml'), {
      statusCode: 415,
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    })
    throw error
  })

  // What ~90 route files actually produce when a caller-supplied path segment
  // reaches an `@db.Uuid` column unvalidated: Postgres rejects the cast and
  // Prisma rethrows it as a known request error.
  app.get('/prisma-malformed-uuid', () => {
    throw new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.attachment.findUnique()` invocation: inconsistent column data: malformed UUID: "not-a-uuid"',
      { code: 'P2023', clientVersion: '6.19.3' },
    )
  })

  app.get('/prisma-record-not-found', () => {
    throw new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found. No record was found for an update on id: secret-internal-id-42',
      { code: 'P2025', clientVersion: '6.19.3' },
    )
  })

  return app
}

test('setErrorHandler maps a ZodError to the canonical VALIDATION_ERROR envelope', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/zod-error' })
    assert.equal(response.statusCode, 400)
    const body = response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    assert.ok(body.error.message)
  } finally {
    await app.close()
  }
})

test('setErrorHandler never echoes the original message for an unclassified error', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/bug' })
    assert.equal(response.statusCode, 500)
    const body = response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'INTERNAL_ERROR')
    assert.ok(!body.error.message.includes('abc123'))
  } finally {
    await app.close()
  }
})

test('setErrorHandler forwards a Fastify client error with its own status and code', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/fastify-client-error' })
    assert.equal(response.statusCode, 415)
    const body = response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
  } finally {
    await app.close()
  }
})

test('setNotFoundHandler emits the canonical NOT_FOUND envelope', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' })
    assert.equal(response.statusCode, 404)
    const body = response.json() as { error: { code: string } }
    assert.equal(body.error.code, 'NOT_FOUND')
  } finally {
    await app.close()
  }
})

test('a Prisma P2023 from a malformed path id answers 400, not 500, and leaks nothing', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/prisma-malformed-uuid' })
    assert.equal(response.statusCode, 400)
    const body = response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    // The Prisma message interpolates the rejected value and the model name;
    // neither may reach the caller.
    assert.ok(!body.error.message.includes('not-a-uuid'))
    assert.ok(!body.error.message.includes('attachment'))
  } finally {
    await app.close()
  }
})

test('a Prisma P2025 answers 404, not 500, and leaks nothing', async () => {
  const app = buildTestApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/prisma-record-not-found' })
    assert.equal(response.statusCode, 404)
    const body = response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'NOT_FOUND')
    assert.ok(!body.error.message.includes('secret-internal-id-42'))
  } finally {
    await app.close()
  }
})
