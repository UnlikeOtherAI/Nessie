import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_IDS, WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import { buildGcloudRunJobArgs } from '../src/control/execution.js'
import { executeWorkflowBuiltinTool } from '../src/run/tools.js'

const makeStateKey = (installationId: string, key: string): string =>
  `${installationId}:${key}`

test('workflow-only tools stay out of the agent builtin tool set', () => {
  assert.equal(BUILTIN_TOOL_IDS.has('state_get'), false)
  assert.equal(BUILTIN_TOOL_IDS.has('state_put'), false)
  assert.equal(BUILTIN_TOOL_IDS.has('change_detect'), false)
  assert.equal(WORKFLOW_TOOL_IDS.has('state_get'), true)
  assert.equal(WORKFLOW_TOOL_IDS.has('state_put'), true)
  assert.equal(WORKFLOW_TOOL_IDS.has('change_detect'), true)
})

test('gcloud run job action deploys current config before executing', () => {
  const { deployArgs, executeArgs } = buildGcloudRunJobArgs({
    env: {
      CHANNEL_ID: 'channel-123',
      RUN_MODE: 'workflow',
    },
    image: 'us-docker.pkg.dev/example/nessie/action:latest',
    jobName: 'nessie-action',
    maxRetries: '1',
    projectId: 'example-project',
    region: 'europe-west2',
    tasks: '2',
  })

  assert.deepEqual(deployArgs, [
    'run',
    'jobs',
    'deploy',
    'nessie-action',
    '--project',
    'example-project',
    '--region',
    'europe-west2',
    '--image',
    'us-docker.pkg.dev/example/nessie/action:latest',
    '--quiet',
    '--format=json',
    '--set-env-vars',
    'CHANNEL_ID=channel-123,RUN_MODE=workflow',
    '--tasks',
    '2',
    '--max-retries',
    '1',
  ])
  assert.deepEqual(executeArgs, [
    'run',
    'jobs',
    'execute',
    'nessie-action',
    '--project',
    'example-project',
    '--region',
    'europe-west2',
    '--wait',
    '--quiet',
    '--format=json',
  ])
})

test('executeWorkflowBuiltinTool persists workflow state and increments versions', async () => {
  const stateEntries = new Map<
    string,
    {
      createdAt: Date
      key: string
      updatedAt: Date
      value: unknown
      valueHash: string
      version: number
    }
  >()

  const prisma = {
    workflowStateEntry: {
      findUnique: async ({
        where,
      }: {
        where: {
          workflowInstallationId_key: {
            key: string
            workflowInstallationId: string
          }
        }
      }) => stateEntries.get(
        makeStateKey(
          where.workflowInstallationId_key.workflowInstallationId,
          where.workflowInstallationId_key.key,
        ),
      ) ?? null,
      upsert: async ({
        create,
        update,
        where,
      }: {
        create: {
          key: string
          value: unknown
          valueHash: string
          version: number
          workflowInstallationId: string
          workflowRunId: string
          workflowStepRunId: string
        }
        update: {
          value: unknown
          valueHash: string
          version: { increment: number }
          workflowRunId: string
          workflowStepRunId: string
        }
        where: {
          workflowInstallationId_key: {
            key: string
            workflowInstallationId: string
          }
        }
      }) => {
        const entryKey = makeStateKey(
          where.workflowInstallationId_key.workflowInstallationId,
          where.workflowInstallationId_key.key,
        )
        const existing = stateEntries.get(entryKey)
        if (existing) {
          const entry = {
            ...existing,
            updatedAt: new Date(),
            value: update.value,
            valueHash: update.valueHash,
            version: existing.version + update.version.increment,
          }
          stateEntries.set(entryKey, entry)
          return entry
        }

        const entry = {
          createdAt: new Date(),
          key: create.key,
          updatedAt: new Date(),
          value: create.value,
          valueHash: create.valueHash,
          version: create.version,
        }
        stateEntries.set(entryKey, entry)
        return entry
      },
    },
  } as const

  const firstPut = await executeWorkflowBuiltinTool(
    'state_put',
    {
      key: 'cursor',
      value: {
        lastId: 'release-1',
      },
    },
    {
      organizationId: '00000000-0000-0000-0000-000000000001',
      prisma: prisma as never,
      workflowInstallationId: '00000000-0000-0000-0000-000000000010',
      workflowRunId: '00000000-0000-0000-0000-000000000011',
      workflowStepRunId: '00000000-0000-0000-0000-000000000012',
    },
  )
  assert.equal(firstPut.success, true)
  assert.equal(firstPut.output.version, 1)

  const secondPut = await executeWorkflowBuiltinTool(
    'state_put',
    {
      key: 'cursor',
      value: {
        lastId: 'release-2',
      },
    },
    {
      organizationId: '00000000-0000-0000-0000-000000000001',
      prisma: prisma as never,
      workflowInstallationId: '00000000-0000-0000-0000-000000000010',
      workflowRunId: '00000000-0000-0000-0000-000000000011',
      workflowStepRunId: '00000000-0000-0000-0000-000000000013',
    },
  )
  assert.equal(secondPut.success, true)
  assert.equal(secondPut.output.version, 2)
  assert.deepEqual(secondPut.output.value, {
    lastId: 'release-2',
  })

  const loaded = await executeWorkflowBuiltinTool(
    'state_get',
    {
      key: 'cursor',
    },
    {
      organizationId: '00000000-0000-0000-0000-000000000001',
      prisma: prisma as never,
      workflowInstallationId: '00000000-0000-0000-0000-000000000010',
      workflowRunId: '00000000-0000-0000-0000-000000000011',
      workflowStepRunId: '00000000-0000-0000-0000-000000000014',
    },
  )
  assert.equal(loaded.success, true)
  assert.equal(loaded.output.found, true)
  assert.equal(loaded.output.version, 2)
  assert.deepEqual(loaded.output.value, {
    lastId: 'release-2',
  })
})

test('executeWorkflowBuiltinTool detects changes against stored workflow state', async () => {
  const stateEntries = new Map<
    string,
    {
      createdAt: Date
      key: string
      updatedAt: Date
      value: unknown
      valueHash: string
      version: number
    }
  >()
  const entryKey = makeStateKey(
    '00000000-0000-0000-0000-000000000020',
    'fingerprint',
  )
  stateEntries.set(entryKey, {
    createdAt: new Date('2026-04-15T00:00:00.000Z'),
    key: 'fingerprint',
    updatedAt: new Date('2026-04-15T00:00:00.000Z'),
    value: {
      hash: 'abc',
    },
    valueHash: 'stored-hash',
    version: 3,
  })

  const prisma = {
    workflowStateEntry: {
      findUnique: async () => stateEntries.get(entryKey) ?? null,
    },
  } as const

  const result = await executeWorkflowBuiltinTool(
    'change_detect',
    {
      key: 'fingerprint',
      value: {
        hash: 'xyz',
      },
    },
    {
      organizationId: '00000000-0000-0000-0000-000000000001',
      prisma: prisma as never,
      workflowInstallationId: '00000000-0000-0000-0000-000000000020',
      workflowRunId: '00000000-0000-0000-0000-000000000021',
      workflowStepRunId: '00000000-0000-0000-0000-000000000022',
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.output.changed, true)
  assert.equal(result.output.changeType, 'updated')
  assert.deepEqual(result.output.previousValue, {
    hash: 'abc',
  })
  assert.deepEqual(result.output.currentValue, {
    hash: 'xyz',
  })
})
