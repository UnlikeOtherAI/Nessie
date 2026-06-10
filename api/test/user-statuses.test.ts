import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, UserStatusSchedule } from '@prisma/client'

import { isScheduleActive } from '../src/services/user-status-schedules.js'
import {
  createUserStatusSchedule,
  resolveActiveStatus,
  UserStatusServiceError,
  type StatusWithRelations,
} from '../src/services/user-statuses.js'

const now = new Date('2026-06-10T12:30:00.000Z')

const makeSchedule = (
  input: Partial<UserStatusSchedule>,
): UserStatusSchedule =>
  ({
    createdAt: now,
    dayOfWeek: null,
    enabled: true,
    endTime: null,
    endsAt: null,
    id: '00000000-0000-4000-8000-000000000010',
    kind: 'date_range',
    label: null,
    startTime: null,
    startsAt: null,
    statusId: '00000000-0000-4000-8000-000000000020',
    timezone: 'UTC',
    updatedAt: now,
    ...input,
  }) as UserStatusSchedule

const makeStatus = (
  input: Partial<StatusWithRelations>,
): StatusWithRelations =>
  ({
    agentEnabled: false,
    agentInstructions: null,
    createdAt: now,
    emoji: null,
    id: '00000000-0000-4000-8000-000000000020',
    isActive: false,
    label: 'Lunch',
    organizationId: '00000000-0000-4000-8000-000000000001',
    rules: [],
    schedules: [],
    updatedAt: now,
    userId: '00000000-0000-4000-8000-000000000002',
    ...input,
  }) as StatusWithRelations

test('date range schedules are active inside their inclusive range', () => {
  const schedule = makeSchedule({
    endsAt: new Date('2026-06-10T13:00:00.000Z'),
    startsAt: new Date('2026-06-10T12:00:00.000Z'),
  })

  assert.equal(isScheduleActive(schedule, now), true)
  assert.equal(isScheduleActive(schedule, new Date('2026-06-10T13:01:00.000Z')), false)
})

test('weekly schedules use the configured timezone and support overnight windows', () => {
  const weekly = makeSchedule({
    dayOfWeek: 3,
    endTime: '13:00',
    kind: 'weekly',
    startTime: '12:00',
  })
  const overnight = makeSchedule({
    dayOfWeek: 2,
    endTime: '02:00',
    kind: 'weekly',
    startTime: '22:00',
  })

  assert.equal(isScheduleActive(weekly, now), true)
  assert.equal(isScheduleActive(overnight, new Date('2026-06-10T01:00:00.000Z')), true)
  assert.equal(isScheduleActive(overnight, new Date('2026-06-10T03:00:00.000Z')), false)
})

test('manual active status wins before scheduled statuses', () => {
  const manual = makeStatus({ emoji: '🌴', isActive: true, label: 'Holiday' })
  const scheduled = makeStatus({
    emoji: '🍱',
    id: '00000000-0000-4000-8000-000000000021',
    label: 'Lunch',
    schedules: [
      makeSchedule({
        endsAt: new Date('2026-06-10T13:00:00.000Z'),
        startsAt: new Date('2026-06-10T12:00:00.000Z'),
      }),
    ],
  })

  assert.deepEqual(resolveActiveStatus([scheduled, manual], now), {
    activeNow: true,
    emoji: '🌴',
    id: manual.id,
    label: 'Holiday',
  })
})

test('weekly schedules reject invalid timezones before persisting', async () => {
  const prisma = {
    userStatus: {
      findFirst: async () => makeStatus({ schedules: [] }),
    },
    userStatusSchedule: {
      create: async () => {
        throw new Error('schedule should not be created')
      },
    },
  } as unknown as PrismaClient

  await assert.rejects(
    createUserStatusSchedule(
      prisma,
      {
        organizationId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000002',
      },
      '00000000-0000-4000-8000-000000000020',
      {
        dayOfWeek: 1,
        endTime: '13:00',
        kind: 'weekly',
        startTime: '12:00',
        timezone: 'Invalid/Timezone',
      },
    ),
    (error) =>
      error instanceof UserStatusServiceError &&
      error.httpStatus === 400 &&
      error.code === 'INVALID_TIMEZONE',
  )
})
