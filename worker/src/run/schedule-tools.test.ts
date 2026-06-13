import assert from 'node:assert/strict'
import test from 'node:test'

import { computeInitialScheduleRunAt } from '@nessie/runtime'
import {
  runCancelScheduledTaskTool,
  runListScheduledTasksTool,
  runScheduleTaskTool,
} from './schedule-tools.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

type FakePrisma = {
  calls: Record<string, unknown[]>
  agentTrigger: {
    count: (args: unknown) => Promise<number>
    create: (args: unknown) => Promise<{ id: string }>
    findFirst: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<unknown[]>
    update: (args: unknown) => Promise<unknown>
  }
  channel: {
    findFirst: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<unknown[]>
  }
  thread: { findFirst: (args: unknown) => Promise<unknown> }
  agentBinding: { findFirst: (args: unknown) => Promise<unknown> }
}

const makeFakePrisma = (overrides: {
  channel?: unknown
  thread?: unknown
  binding?: unknown
  findFirstTrigger?: unknown
  findManyTriggers?: unknown[]
  activeCount?: number
} = {}): FakePrisma => {
  const calls: Record<string, unknown[]> = {}
  const record = (key: string, value: unknown) => {
    calls[key] = calls[key] ?? []
    ;(calls[key] as unknown[]).push(value)
  }
  return {
    calls,
    agentTrigger: {
      count: async (args) => {
        record('agentTrigger.count', args)
        return overrides.activeCount ?? 0
      },
      create: async (args) => {
        record('agentTrigger.create', args)
        return { id: 'trigger-1' }
      },
      findFirst: async (args) => {
        record('agentTrigger.findFirst', args)
        return overrides.findFirstTrigger ?? null
      },
      findMany: async (args) => {
        record('agentTrigger.findMany', args)
        return overrides.findManyTriggers ?? []
      },
      update: async (args) => {
        record('agentTrigger.update', args)
        return {}
      },
    },
    channel: {
      findFirst: async (args) => {
        record('channel.findFirst', args)
        return overrides.channel ?? null
      },
      findMany: async (args) => {
        record('channel.findMany', args)
        return overrides.channel
          ? Array.isArray(overrides.channel)
            ? overrides.channel
            : [overrides.channel]
          : []
      },
    },
    thread: {
      findFirst: async (args) => {
        record('thread.findFirst', args)
        return overrides.thread ?? null
      },
    },
    agentBinding: {
      findFirst: async (args) => {
        record('agentBinding.findFirst', args)
        return overrides.binding ?? null
      },
    },
  }
}

const makeContext = (
  prisma: FakePrisma,
  overrides: { agentKind?: 'personal_assistant' | 'shared' } = {},
): BuiltinToolRuntimeContext =>
  ({
    agentId: 'agent-1',
    agentKind: overrides.agentKind ?? 'shared',
    actorContext: {
      actor: { actorId: 'user-1', actorType: 'user', roles: [] },
      actionContext: {},
      tenant: { organizationId: 'org-1' },
    },
    channel: { id: 'channel-1', organizationId: 'org-1', systemChannelType: null },
    prisma: prisma as unknown as BuiltinToolRuntimeContext['prisma'],
    realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
    run: { id: 'run-1', messageId: 'msg-1', threadId: 'thread-1' },
  }) as unknown as BuiltinToolRuntimeContext

const FUTURE_ISO = '2999-01-01T09:00:00.000Z'

test('computeInitialScheduleRunAt: one-off returns the requested instant', () => {
  const result = computeInitialScheduleRunAt({
    config: { mode: 'once', at: FUTURE_ISO },
    now: new Date('2026-01-01T00:00:00.000Z'),
    type: 'scheduled',
  })
  assert.equal(result?.toISOString(), FUTURE_ISO)
})

test('computeInitialScheduleRunAt: recurring cron returns the next fire', () => {
  const now = new Date('2026-01-01T08:00:00.000Z')
  const result = computeInitialScheduleRunAt({
    config: { cron: '0 9 * * *', timezone: 'UTC' },
    now,
    type: 'scheduled',
  })
  assert.equal(result?.toISOString(), '2026-01-01T09:00:00.000Z')
})

test('computeInitialScheduleRunAt: interval returns now + minutes', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const result = computeInitialScheduleRunAt({
    config: { interval_minutes: 30 },
    now,
    type: 'interval',
  })
  assert.equal(result?.toISOString(), '2026-01-01T00:30:00.000Z')
})

test('computeInitialScheduleRunAt: invalid cron yields null', () => {
  const result = computeInitialScheduleRunAt({
    config: { cron: 'not a cron' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    type: 'scheduled',
  })
  assert.equal(result, null)
})

test('schedule_task one-off into the current conversation creates a trigger', async () => {
  const prisma = makeFakePrisma()
  const result = await runScheduleTaskTool(makeContext(prisma), {
    instructions: 'Research the James Webb telescope and summarise here',
    schedule: { kind: 'once', at: FUTURE_ISO },
    name: 'JWST one-off',
  })

  assert.equal(result.toolName, 'schedule_task')
  const create = (prisma.calls['agentTrigger.create'] as Array<{ data: Record<string, unknown> }>)[0]!
  assert.equal(create.data.type, 'scheduled')
  assert.equal(create.data.agentId, 'agent-1')
  assert.equal(create.data.targetChannelId, 'channel-1')
  assert.equal(create.data.targetThreadId, 'thread-1')
  assert.equal((create.data.nextRunAt as Date).toISOString(), FUTURE_ISO)
  const config = create.data.config as Record<string, unknown>
  assert.equal(config.mode, 'once')
  assert.equal(config.prompt, 'Research the James Webb telescope and summarise here')
  assert.equal(config.createdViaTool, true)
  assert.equal(config.createdByUserId, 'user-1')
  // No channel lookup or binding check for the current conversation.
  assert.equal(prisma.calls['channel.findFirst'], undefined)
  assert.equal(prisma.calls['channel.findMany'], undefined)
  assert.equal(prisma.calls['agentBinding.findFirst'], undefined)
})

test('schedule_task recurring stores cron config', async () => {
  const prisma = makeFakePrisma()
  await runScheduleTaskTool(makeContext(prisma), {
    instructions: 'Daily standup digest',
    schedule: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'Europe/London' },
  })
  const create = (prisma.calls['agentTrigger.create'] as Array<{ data: Record<string, unknown> }>)[0]!
  const config = create.data.config as Record<string, unknown>
  assert.equal(config.cron, '0 9 * * 1-5')
  assert.equal(config.timezone, 'Europe/London')
})

test('schedule_task rejects when the active-schedule cap is reached', async () => {
  const prisma = makeFakePrisma({ activeCount: 25 })
  await assert.rejects(
    () =>
      runScheduleTaskTool(makeContext(prisma), {
        instructions: 'one too many',
        schedule: { kind: 'interval', every_minutes: 60 },
      }),
    /limit 25/,
  )
  assert.equal(prisma.calls['agentTrigger.create'], undefined)
})

test('schedule_task rejects a one-off in the past', async () => {
  const prisma = makeFakePrisma()
  await assert.rejects(
    () =>
      runScheduleTaskTool(makeContext(prisma), {
        instructions: 'too late',
        schedule: { kind: 'once', at: '2000-01-01T00:00:00.000Z' },
      }),
    /in the future/,
  )
})

test('schedule_task rejects an unknown schedule kind', async () => {
  const prisma = makeFakePrisma()
  await assert.rejects(
    () =>
      runScheduleTaskTool(makeContext(prisma), {
        instructions: 'x',
        schedule: { kind: 'someday' },
      }),
    /schedule\.kind/,
  )
})

test('schedule_task into another channel requires the agent to be a member', async () => {
  const prisma = makeFakePrisma({
    channel: { id: 'channel-2', label: 'research' },
    thread: { id: 'thread-2' },
    binding: null,
  })
  await assert.rejects(
    () =>
      runScheduleTaskTool(makeContext(prisma), {
        instructions: 'post to research',
        schedule: { kind: 'interval', every_minutes: 60 },
        target: 'research',
      }),
    /not a member/,
  )
})

test('schedule_task: personal assistant reaches any channel without a binding', async () => {
  const prisma = makeFakePrisma({
    channel: { id: 'channel-2', label: 'general' },
    thread: { id: 'thread-2' },
    binding: null, // unbound — must not matter for the personal assistant
  })
  const result = await runScheduleTaskTool(
    makeContext(prisma, { agentKind: 'personal_assistant' }),
    {
      instructions: 'post the weekly update',
      schedule: { kind: 'interval', every_minutes: 60 },
      target: 'general',
    },
  )

  assert.equal(result.toolName, 'schedule_task')
  const create = (prisma.calls['agentTrigger.create'] as Array<{ data: Record<string, unknown> }>)[0]!
  assert.equal(create.data.targetChannelId, 'channel-2')
  // No binding lookup: the personal assistant is its owner's delegate.
  assert.equal(prisma.calls['agentBinding.findFirst'], undefined)
  // Channel resolution is org-wide (no public/membership access clause).
  const lookup = (
    prisma.calls['channel.findMany'] as Array<{ where: { AND: Array<Record<string, unknown>> } }>
  )[0]!
  assert.deepEqual(lookup.where.AND[0], { organizationId: 'org-1' })
})

test('schedule_task rejects ambiguous bare channel names', async () => {
  const prisma = makeFakePrisma({
    channel: [
      {
        id: 'channel-2',
        label: 'general',
        slug: 'general',
        team: { name: 'Default Team', project: { name: 'Default Project' } },
      },
      {
        id: 'channel-3',
        label: 'General',
        slug: 'general',
        team: { name: 'Ops Team', project: { name: 'Ops Project' } },
      },
    ],
    thread: { id: 'thread-2' },
    binding: { id: 'binding-1' },
  })

  await assert.rejects(
    () =>
      runScheduleTaskTool(makeContext(prisma), {
        instructions: 'post to general',
        schedule: { kind: 'interval', every_minutes: 60 },
        target: 'general',
      }),
    /ambiguous.*default-project\/general.*ops-project\/general/is,
  )
  assert.equal(prisma.calls['agentTrigger.create'], undefined)
})

test('schedule_task resolves scoped channel slugs', async () => {
  const prisma = makeFakePrisma({
    channel: [
      {
        id: 'channel-2',
        label: 'general',
        slug: 'general',
        team: { name: 'Default Team', project: { name: 'Default Project' } },
      },
      {
        id: 'channel-3',
        label: 'General',
        slug: 'general',
        team: { name: 'Ops Team', project: { name: 'Ops Project' } },
      },
    ],
    thread: { id: 'thread-3' },
    binding: { id: 'binding-1' },
  })

  await runScheduleTaskTool(makeContext(prisma), {
    instructions: 'post to scoped general',
    schedule: { kind: 'interval', every_minutes: 60 },
    target: 'ops-project/general',
  })

  const create = (prisma.calls['agentTrigger.create'] as Array<{ data: Record<string, unknown> }>)[0]!
  assert.equal(create.data.targetChannelId, 'channel-3')
})

test('schedule_task into another channel succeeds when bound', async () => {
  const prisma = makeFakePrisma({
    channel: { id: 'channel-2', label: 'research' },
    thread: { id: 'thread-2' },
    binding: { id: 'binding-1' },
  })
  await runScheduleTaskTool(makeContext(prisma), {
    instructions: 'post to research',
    schedule: { kind: 'interval', every_minutes: 60 },
    target: 'research',
  })
  const create = (prisma.calls['agentTrigger.create'] as Array<{ data: Record<string, unknown> }>)[0]!
  assert.equal(create.data.targetChannelId, 'channel-2')
  assert.equal(create.data.targetThreadId, 'thread-2')
})

test('list_scheduled_tasks reports nothing when empty', async () => {
  const prisma = makeFakePrisma({ findManyTriggers: [] })
  const result = await runListScheduledTasksTool(makeContext(prisma))
  assert.match(result.outputPreview, /no scheduled tasks/i)
})

test('list_scheduled_tasks formats existing schedules', async () => {
  const prisma = makeFakePrisma({
    findManyTriggers: [
      {
        id: 'trigger-1',
        name: 'JWST',
        config: {
          prompt: 'research jwst',
          cron: '0 9 * * *',
          createdViaTool: true,
          createdByUserId: 'user-1',
        },
        enabled: true,
        status: 'active',
        nextRunAt: new Date('2026-01-01T09:00:00.000Z'),
        targetChannel: { label: 'research' },
      },
    ],
  })
  const result = await runListScheduledTasksTool(makeContext(prisma))
  assert.match(result.outputPreview, /trigger-1/)
  assert.match(result.outputPreview, /#research/)
  assert.match(result.outputPreview, /cron "0 9 \* \* \*"/)
})

test('cancel_scheduled_task disables a matching trigger', async () => {
  const prisma = makeFakePrisma({
    findFirstTrigger: {
      id: 'trigger-1',
      name: 'JWST',
      enabled: true,
      config: { createdViaTool: true, createdByUserId: 'user-1' },
    },
  })
  const result = await runCancelScheduledTaskTool(makeContext(prisma), { id: 'trigger-1' })
  const update = (prisma.calls['agentTrigger.update'] as Array<{ data: Record<string, unknown> }>)[0]!
  assert.equal(update.data.enabled, false)
  assert.equal(update.data.status, 'paused')
  assert.match(result.outputPreview, /Cancelled/)
})

test('cancel_scheduled_task refuses another user\'s schedule from an autonomous run', async () => {
  // No effectiveUserId on the context -> autonomous; must not cancel a user-owned task.
  const prisma = makeFakePrisma({
    findFirstTrigger: {
      id: 'trigger-1',
      name: 'owned',
      enabled: true,
      config: { createdViaTool: true, createdByUserId: 'someone-else' },
    },
  })
  const ctx = makeContext(prisma)
  ;(ctx.actorContext.actor as { actorType: string }).actorType = 'agent'
  await assert.rejects(
    () => runCancelScheduledTaskTool(ctx, { id: 'trigger-1' }),
    /No scheduled task found/,
  )
  assert.equal(prisma.calls['agentTrigger.update'], undefined)
})

test('cancel_scheduled_task errors when nothing matches', async () => {
  const prisma = makeFakePrisma({ findFirstTrigger: null })
  await assert.rejects(
    () => runCancelScheduledTaskTool(makeContext(prisma), { name: 'missing' }),
    /No scheduled task found/,
  )
})

test('cancel_scheduled_task requires an id or name', async () => {
  const prisma = makeFakePrisma()
  await assert.rejects(
    () => runCancelScheduledTaskTool(makeContext(prisma), {}),
    /requires either/,
  )
})
