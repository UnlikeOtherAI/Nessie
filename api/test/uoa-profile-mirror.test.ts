import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { syncProfileMirrorFromClaims } from '../src/services/uoa-profile-mirror.js'

const userId = '00000000-0000-4000-8000-00000000000a'

type Row = { avatarUrl: string | null; displayName: string }

const makePrisma = (row: Row | null) => {
  const updates: Array<Record<string, unknown>> = []
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        assert.equal(where.id, userId)
        return row
      },
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        assert.equal(where.id, userId)
        updates.push(data)
        return {}
      },
    },
  } as unknown as PrismaClient

  return { prisma, updates }
}

test('a changed name or picture is written back to the mirror', async () => {
  const { prisma, updates } = makePrisma({
    avatarUrl: 'https://uoa.test/old.png',
    displayName: 'ada.lovelace@example.com',
  })

  await syncProfileMirrorFromClaims(prisma, userId, {
    avatarUrl: 'https://uoa.test/new.png',
    displayName: 'Ada Lovelace',
  })

  assert.deepEqual(updates, [{
    displayName: 'Ada Lovelace',
    avatarUrl: 'https://uoa.test/new.png',
  }])
})

test('only the field that actually changed is written', async () => {
  const { prisma, updates } = makePrisma({
    avatarUrl: 'https://uoa.test/same.png',
    displayName: 'Ada L.',
  })

  await syncProfileMirrorFromClaims(prisma, userId, {
    avatarUrl: 'https://uoa.test/same.png',
    displayName: 'Ada Lovelace',
  })

  assert.deepEqual(updates, [{ displayName: 'Ada Lovelace' }])
})

test('unchanged claims write nothing at all', async () => {
  const { prisma, updates } = makePrisma({
    avatarUrl: 'https://uoa.test/same.png',
    displayName: 'Ada Lovelace',
  })

  await syncProfileMirrorFromClaims(prisma, userId, {
    avatarUrl: 'https://uoa.test/same.png',
    displayName: 'Ada Lovelace',
  })

  assert.deepEqual(updates, [])
})

test('a claim the provider did not assert never blanks the mirror', async () => {
  // UOA's access token carries no picture claim, so an avatar captured from a
  // generic OIDC `picture` (or nothing at all) must survive the sync rather
  // than being cleared by its absence.
  const { prisma, updates } = makePrisma({
    avatarUrl: 'https://provider.test/picture.png',
    displayName: 'Ada Lovelace',
  })

  await syncProfileMirrorFromClaims(prisma, userId, { displayName: 'Ada Lovelace' })
  await syncProfileMirrorFromClaims(prisma, userId, {})
  await syncProfileMirrorFromClaims(prisma, userId, { displayName: '   ' })

  assert.deepEqual(updates, [])
})

test('a missing user row is a no-op, not a crash', async () => {
  const { prisma, updates } = makePrisma(null)

  await syncProfileMirrorFromClaims(prisma, userId, { displayName: 'Ada Lovelace' })

  assert.deepEqual(updates, [])
})
