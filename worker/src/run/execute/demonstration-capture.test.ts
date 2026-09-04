import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { captureDemonstrationToolEnd } from './demonstration-capture.js'

const captureInput = {
  agentId: '10000000-0000-4000-8000-000000000001',
  argumentsValue: {
    headers: { authorization: 'Bearer private-token' },
    query: 'public release notes',
  },
  demonstrationId: '10000000-0000-4000-8000-000000000005',
  durationMs: 42,
  endedAt: new Date('2026-08-31T10:00:01.000Z'),
  organizationId: '10000000-0000-4000-8000-000000000002',
  runId: '10000000-0000-4000-8000-000000000003',
  startedAt: new Date('2026-08-31T10:00:00.000Z'),
  success: true,
  threadId: '10000000-0000-4000-8000-000000000004',
  toolName: 'web_fetch',
}

test('demonstration capture writes full redacted arguments behind the recording predicate', async () => {
  const statements: Array<{ values?: unknown[] }> = []
  const prisma = {
    $executeRaw: async (statement: { values?: unknown[] }) => {
      statements.push(statement)
      return 1
    },
  } as unknown as PrismaClient

  await captureDemonstrationToolEnd(prisma, captureInput)

  assert.equal(statements.length, 1)
  const argumentJson = statements[0]?.values?.find(
    (value): value is string => typeof value === 'string' && value.includes('public release notes'),
  )
  assert.ok(argumentJson)
  assert.equal(argumentJson.includes('private-token'), false)
  assert.equal(argumentJson.includes('[REDACTED]'), true)
})

test('demonstration capture masks credentials stored under ordinary keys', async () => {
  const statements: Array<{ values?: unknown[] }> = []
  const prisma = {
    $executeRaw: async (statement: { values?: unknown[] }) => {
      statements.push(statement)
      return 1
    },
  } as unknown as PrismaClient
  const token = ['sk', 'proj', 'abcdefghijklmnopqrstuv'].join('-')

  await captureDemonstrationToolEnd(prisma, {
    ...captureInput,
    argumentsValue: { command: `publish ${token}` },
  })

  const serialized = JSON.stringify(statements[0]?.values)
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuv/)
  assert.match(serialized, new RegExp(`sk-proj-${'•'.repeat(12)}`))
})

test('demonstration control calls do not record themselves', async () => {
  let writes = 0
  const prisma = {
    $executeRaw: async () => {
      writes += 1
      return 1
    },
  } as unknown as PrismaClient

  await captureDemonstrationToolEnd(prisma, {
    ...captureInput,
    toolName: 'demonstration_start',
  })

  assert.equal(writes, 0)
})

test('demonstrations retain no mail or account arguments', async () => {
  const statements: Array<{ values?: unknown[] }> = []
  const prisma = {
    $executeRaw: async (statement: { values?: unknown[] }) => {
      statements.push(statement)
      return 1
    },
  } as unknown as PrismaClient

  await captureDemonstrationToolEnd(prisma, {
    ...captureInput,
    argumentsValue: {
      oauthCode: 'code-for-owner@example.test',
      subject: 'Private subject',
      to: ['recipient@example.test'],
    },
    toolName: 'email_account_connect',
  })
  await captureDemonstrationToolEnd(prisma, {
    ...captureInput,
    argumentsValue: {
      subject: 'Private subject',
      text: 'Private body',
      to: ['recipient@example.test'],
    },
    toolName: 'mailbox_send',
  })

  const persisted = JSON.stringify(statements)
  assert.doesNotMatch(persisted, /owner@example\.test|recipient@example\.test|Private subject|Private body|oauthCode/)
  assert.equal(statements.filter((statement) => statement.values?.includes('{}')).length, 2)
})

test('unarmed runs do not query demonstration storage', async () => {
  let writes = 0
  const prisma = {
    $executeRaw: async () => {
      writes += 1
      return 1
    },
  } as unknown as PrismaClient

  await captureDemonstrationToolEnd(prisma, {
    ...captureInput,
    demonstrationId: null,
  })

  assert.equal(writes, 0)
})

test('demonstration capture failure does not fail the completed tool call', async () => {
  const prisma = {
    $executeRaw: async () => {
      throw new Error('database unavailable')
    },
  } as unknown as PrismaClient

  await assert.doesNotReject(captureDemonstrationToolEnd(prisma, captureInput))
})
