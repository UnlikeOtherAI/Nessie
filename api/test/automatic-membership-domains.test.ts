/**
 * The domain-claim state machine, and the instance-wide exclusivity the
 * partial unique indexes enforce.
 *
 * The state machine runs against a fake Prisma and an injected DNS seam. The
 * exclusivity cases need real Postgres, because a partial unique index is the
 * thing under test and no fake can stand in for it — they gate on
 * `DATABASE_URL` like every other database suite here.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { DomainVerificationDns } from '@nessie/team-admin'
import { CHALLENGE_TTL_MS, SECOND_OBSERVATION_MIN_GAP_MS } from '@nessie/team-admin'

import {
  AutomaticMembershipDomainError,
  claimDomain,
  revokeDomain,
  rotateChallenge,
  setDomainStatus,
  verifyDomain,
} from '../src/services/automatic-membership/domains.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const ORG = '00000000-0000-4000-8000-0000000000a1'

type Row = {
  id: string
  organizationId: string
  domain: string
  status: string
  challenge: string
  challengeIssuedAt: Date
  challengeExpiresAt: Date
  firstSeenAt: Date | null
  verifiedAt: Date | null
  lastCheckedAt: Date | null
  lastCheckOutcome: string | null
  lastCheckDetail: string | null
  revalidationFailures: number
  createdByUserId: string | null
}

/** A fake that models the partial unique indexes the migration creates. */
const LIVE = new Set(['verified', 'active', 'suspended'])
const ORG_LIVE = new Set(['pending', 'verified', 'active', 'suspended'])

const makePrisma = (rows: Row[]) => ({
  automaticMembershipDomain: {
    create: async ({ data }: { data: Partial<Row> }) => {
      const next = { id: randomUUID(), ...data } as Row
      if (rows.some((row) => row.domain === next.domain && LIVE.has(row.status))) {
        throw Object.assign(new Error('unique'), { code: 'P2002' })
      }
      if (rows.some((row) =>
        row.domain === next.domain
        && row.organizationId === next.organizationId
        && ORG_LIVE.has(row.status))) {
        throw Object.assign(new Error('unique'), { code: 'P2002' })
      }
      rows.push(next)
      return next
    },
    findFirst: async ({ where }: { where: Record<string, never> }) => {
      const w = where as Record<string, unknown>
      return rows.find((row) => {
        if (w.id && row.id !== w.id) return false
        if (w.organizationId && row.organizationId !== w.organizationId) return false
        if (w.domain && row.domain !== w.domain) return false
        const status = w.status as { in?: string[]; not?: string } | undefined
        if (status?.in && !status.in.includes(row.status)) return false
        if (status?.not && row.status === status.not) return false
        return true
      }) ?? null
    },
    update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const row = rows.find((entry) => entry.id === where.id)
      if (!row) throw new Error('missing row')
      const next = { ...row, ...data } as Row
      if (
        LIVE.has(String(next.status))
        && rows.some((other) =>
          other.id !== row.id && other.domain === next.domain && LIVE.has(other.status))
      ) {
        throw Object.assign(new Error('unique'), { code: 'P2002' })
      }
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      const status = where.status as { not?: string } | undefined
      const row = rows.find((entry) =>
        entry.id === where.id
        && entry.organizationId === where.organizationId
        && (!status?.not || entry.status !== status.not))
      if (!row) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
  },
})

const dnsMatching = (challenge: string): DomainVerificationDns => ({
  txt: async () => [[`nessie-domain-verification=${challenge}`]],
})
const dnsEmpty: DomainVerificationDns = { txt: async () => [] }

test('a claim normalises the domain and starts pending', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: '  Example.COM. ',
    organizationId: ORG,
  })
  assert.equal(created.domain, 'example.com')
  assert.equal(rows[0]?.status, 'pending')
  assert.ok(rows[0]?.challenge.length >= 52)
})

test('a consumer provider is refused with its specific reason', async () => {
  const prisma = makePrisma([])
  await assert.rejects(
    claimDomain(prisma as never, {
      createdByUserId: null,
      domain: 'gmail.com',
      organizationId: ORG,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AutomaticMembershipDomainError)
      assert.equal(error.statusCode, 400)
      assert.equal(error.rejection, 'consumer_provider')
      return true
    },
  )
})

test('an IP literal, a localhost name and a public suffix are all refused', async () => {
  const prisma = makePrisma([])
  for (const [domain, reason] of [
    ['127.0.0.1', 'ip_literal'],
    ['localhost', 'localhost'],
    ['co.uk', 'public_suffix'],
  ] as const) {
    await assert.rejects(
      claimDomain(prisma as never, { createdByUserId: null, domain, organizationId: ORG }),
      (error: unknown) =>
        error instanceof AutomaticMembershipDomainError && error.rejection === reason,
    )
  }
})

test('verification takes two observations at least ten minutes apart', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: 'example.com',
    organizationId: ORG,
  })
  const dns = dnsMatching(created.challenge)
  const start = new Date()

  const first = await verifyDomain(prisma as never, created.id, ORG, dns, start)
  assert.equal(first.kind, 'first_observation')
  assert.equal(rows[0]?.status, 'pending', 'one lookup is not proof')

  const tooSoon = await verifyDomain(
    prisma as never, created.id, ORG, dns,
    new Date(start.getTime() + 60_000),
  )
  assert.equal(tooSoon.kind, 'awaiting_second_observation')
  assert.equal(rows[0]?.status, 'pending')

  const second = await verifyDomain(
    prisma as never, created.id, ORG, dns,
    new Date(start.getTime() + SECOND_OBSERVATION_MIN_GAP_MS + 1000),
  )
  assert.equal(second.kind, 'verified')
  assert.equal(rows[0]?.status, 'verified')
})

test('a failing check records the reason and never verifies', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: 'example.com',
    organizationId: ORG,
  })
  const outcome = await verifyDomain(prisma as never, created.id, ORG, dnsEmpty)
  assert.equal(outcome.kind, 'failed')
  assert.equal(rows[0]?.status, 'pending')
  assert.equal(rows[0]?.lastCheckOutcome, 'no_record')
  assert.match(String(rows[0]?.lastCheckDetail), /_nessie-domain-verification\.example\.com/)
})

test('an expired challenge cannot verify', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: 'example.com',
    organizationId: ORG,
  })
  const outcome = await verifyDomain(
    prisma as never, created.id, ORG, dnsMatching(created.challenge),
    new Date(Date.now() + CHALLENGE_TTL_MS + 1000),
  )
  assert.equal(outcome.kind, 'expired')
  assert.equal(rows[0]?.status, 'pending')
})

test('rotating a challenge returns an active domain to pending', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: 'example.com',
    organizationId: ORG,
  })
  rows[0]!.status = 'active'
  const next = await rotateChallenge(prisma as never, created.id, ORG)
  assert.notEqual(next, created.challenge)
  assert.equal(rows[0]?.status, 'pending', 'the old proof no longer holds')
  assert.equal(rows[0]?.firstSeenAt, null)
  assert.equal(rows[0]?.verifiedAt, null)
})

test('activation requires a proven claim; suspension is always allowed', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null,
    domain: 'example.com',
    organizationId: ORG,
  })
  await assert.rejects(
    setDomainStatus(prisma as never, created.id, ORG, 'active'),
    (error: unknown) =>
      error instanceof AutomaticMembershipDomainError
      && error.code === 'AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED',
  )
  rows[0]!.status = 'verified'
  await setDomainStatus(prisma as never, created.id, ORG, 'active')
  assert.equal(rows[0]?.status, 'active')
  await setDomainStatus(prisma as never, created.id, ORG, 'suspended')
  assert.equal(rows[0]?.status, 'suspended')
})

test('another organisation cannot verify a domain that is already claimed', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const other = '00000000-0000-4000-8000-0000000000b2'

  const mine = await claimDomain(prisma as never, {
    createdByUserId: null, domain: 'example.com', organizationId: ORG,
  })
  // Both may hold a pending claim: `pending` is outside the live index.
  const theirs = await claimDomain(prisma as never, {
    createdByUserId: null, domain: 'example.com', organizationId: other,
  })

  const start = new Date()
  const ready = new Date(start.getTime() + SECOND_OBSERVATION_MIN_GAP_MS + 1000)
  await verifyDomain(prisma as never, mine.id, ORG, dnsMatching(mine.challenge), start)
  const won = await verifyDomain(prisma as never, mine.id, ORG, dnsMatching(mine.challenge), ready)
  assert.equal(won.kind, 'verified')

  await verifyDomain(prisma as never, theirs.id, other, dnsMatching(theirs.challenge), start)
  const lost = await verifyDomain(
    prisma as never, theirs.id, other, dnsMatching(theirs.challenge), ready,
  )
  assert.equal(lost.kind, 'claimed_elsewhere', 'first to prove DNS wins the lock')
  assert.equal(rows.find((row) => row.id === theirs.id)?.status, 'pending')
})

test('revoking releases the claim and keeps the row', async () => {
  const rows: Row[] = []
  const prisma = makePrisma(rows)
  const created = await claimDomain(prisma as never, {
    createdByUserId: null, domain: 'example.com', organizationId: ORG,
  })
  await revokeDomain(prisma as never, created.id, ORG)
  assert.equal(rows[0]?.status, 'revoked')
  await assert.rejects(revokeDomain(prisma as never, created.id, ORG))
})

// --- Postgres: the partial unique indexes themselves -------------------------

runDatabaseTest('the live-claim index is instance-wide, and revoking frees it', async () => {
  const prisma = new PrismaClient()
  const domain = `example-${randomUUID().slice(0, 8)}.com`
  const orgA = await prisma.organization.create({
    data: { externalOrgId: `ext-${randomUUID()}`, name: 'Suite Org A' },
    select: { id: true },
  })
  const orgB = await prisma.organization.create({
    data: { externalOrgId: `ext-${randomUUID()}`, name: 'Suite Org B' },
    select: { id: true },
  })

  const base = {
    challenge: 'A'.repeat(52),
    challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    challengeIssuedAt: new Date(),
    domain,
  }

  try {
    const first = await prisma.automaticMembershipDomain.create({
      data: { ...base, organizationId: orgA.id, status: 'active' },
      select: { id: true },
    })

    // A second organisation cannot hold a live claim on the same domain.
    await assert.rejects(
      prisma.automaticMembershipDomain.create({
        data: { ...base, organizationId: orgB.id, status: 'verified' },
      }),
      /Unique constraint|P2002/,
    )

    // But it may hold a pending one while it publishes its own record.
    const pendingB = await prisma.automaticMembershipDomain.create({
      data: { ...base, organizationId: orgB.id, status: 'pending' },
      select: { id: true },
    })

    // Releasing the first frees the lock for the second.
    await prisma.automaticMembershipDomain.update({
      data: { status: 'revoked' }, where: { id: first.id },
    })
    await prisma.automaticMembershipDomain.update({
      data: { status: 'verified' }, where: { id: pendingB.id },
    })

    // And the original organisation can claim it again — which a plain unique
    // constraint on (organizationId, domain) would have blocked forever.
    const reclaimed = await prisma.automaticMembershipDomain.create({
      data: { ...base, organizationId: orgA.id, status: 'pending' },
      select: { id: true, status: true },
    })
    assert.equal(reclaimed.status, 'pending')
  } finally {
    // Scoped to this suite's own seed, never a global delete.
    await prisma.automaticMembershipDomain.deleteMany({ where: { domain } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('one organisation cannot stack two live claims on one domain', async () => {
  const prisma = new PrismaClient()
  const domain = `example-${randomUUID().slice(0, 8)}.com`
  const org = await prisma.organization.create({
    data: { externalOrgId: `ext-${randomUUID()}`, name: 'Suite Org C' },
    select: { id: true },
  })
  const base = {
    challenge: 'B'.repeat(52),
    challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    challengeIssuedAt: new Date(),
    domain,
    organizationId: org.id,
  }
  try {
    await prisma.automaticMembershipDomain.create({ data: { ...base, status: 'pending' } })
    await assert.rejects(
      prisma.automaticMembershipDomain.create({ data: { ...base, status: 'pending' } }),
      /Unique constraint|P2002/,
    )
  } finally {
    await prisma.automaticMembershipDomain.deleteMany({ where: { domain } })
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  }
})
