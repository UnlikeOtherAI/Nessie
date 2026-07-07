import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkflowRunEventContext,
  buildWorkflowRunTerminalEventPayload,
} from '../src/control/workflow-run-events.js'

const ORG_ID = '11111111-1111-1111-1111-111111111111'
const PROJECT_ID = '22222222-2222-2222-2222-222222222222'
const TEAM_ID = '33333333-3333-3333-3333-333333333333'
const CHANNEL_ID = '44444444-4444-4444-4444-444444444444'
const RUN_ID = '55555555-5555-5555-5555-555555555555'
const INSTALLATION_ID = '66666666-6666-6666-6666-666666666666'
const TEMPLATE_ID = '77777777-7777-7777-7777-777777777777'

test('buildWorkflowRunEventContext maps loadWorkflowGraph shape into event context', () => {
  const context = buildWorkflowRunEventContext({
    installation: {
      channelId: CHANNEL_ID,
      id: INSTALLATION_ID,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
      workflowTemplateId: TEMPLATE_ID,
    },
    run: {
      id: RUN_ID,
      organizationId: ORG_ID,
      startedByActorId: 'agent-1',
      startedByActorType: 'agent',
    },
  })

  assert.deepEqual(context, {
    channelId: CHANNEL_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    startedByActorId: 'agent-1',
    startedByActorType: 'agent',
    teamId: TEAM_ID,
    workflowInstallationId: INSTALLATION_ID,
    workflowRunId: RUN_ID,
    workflowTemplateId: TEMPLATE_ID,
  })
})

test('buildWorkflowRunTerminalEventPayload emits workflow.run.completed with no errorMessage', () => {
  const job = buildWorkflowRunTerminalEventPayload(
    {
      channelId: CHANNEL_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      startedByActorId: 'agent-1',
      startedByActorType: 'agent',
      teamId: TEAM_ID,
      workflowInstallationId: INSTALLATION_ID,
      workflowRunId: RUN_ID,
      workflowTemplateId: TEMPLATE_ID,
    },
    'completed',
  )

  assert.equal(job.topic, 'trigger.event.dispatch')
  assert.equal(job.idempotencyKey, `trigger-event:${ORG_ID}:workflow-run-event:${RUN_ID}:completed`)
  assert.equal(job.payload.eventType, 'workflow.run.completed')
  assert.equal(job.payload.dedupeKey, `workflow-run-event:${RUN_ID}:completed`)
  assert.equal(job.payload.source, `workflow-run:${RUN_ID}`)
  assert.deepEqual(job.payload.payload, {
    errorMessage: undefined,
    organizationId: ORG_ID,
    status: 'completed',
    workflowInstallationId: INSTALLATION_ID,
    workflowRunId: RUN_ID,
    workflowTemplateId: TEMPLATE_ID,
  })
  assert.equal(job.payload.actorContext.tenant.organizationId, ORG_ID)
  assert.equal(job.payload.actorContext.tenant.projectId, PROJECT_ID)
  assert.equal(job.payload.actorContext.tenant.teamId, TEAM_ID)
  assert.equal(job.payload.actorContext.tenant.channelId, CHANNEL_ID)
  assert.equal(job.payload.actorContext.actor.actorId, 'agent-1')
  assert.equal(job.payload.actorContext.actor.actorType, 'agent')
})

test('buildWorkflowRunTerminalEventPayload emits workflow.run.failed with errorMessage', () => {
  const job = buildWorkflowRunTerminalEventPayload(
    {
      organizationId: ORG_ID,
      startedByActorId: 'user-1',
      startedByActorType: 'user',
      workflowInstallationId: INSTALLATION_ID,
      workflowRunId: RUN_ID,
    },
    'failed',
    'Tool call failed: http_fetch',
  )

  assert.equal(job.payload.eventType, 'workflow.run.failed')
  assert.equal(job.payload.dedupeKey, `workflow-run-event:${RUN_ID}:failed`)
  assert.deepEqual(job.payload.payload, {
    errorMessage: 'Tool call failed: http_fetch',
    organizationId: ORG_ID,
    status: 'failed',
    workflowInstallationId: INSTALLATION_ID,
    workflowRunId: RUN_ID,
    workflowTemplateId: undefined,
  })
})

test('buildWorkflowRunTerminalEventPayload dedupe key is stable for the same run and status', () => {
  const context = {
    organizationId: ORG_ID,
    startedByActorId: 'agent-1',
    startedByActorType: 'agent',
    workflowInstallationId: INSTALLATION_ID,
    workflowRunId: RUN_ID,
  }

  const first = buildWorkflowRunTerminalEventPayload(context, 'failed', 'boom')
  const second = buildWorkflowRunTerminalEventPayload(context, 'failed', 'boom')

  assert.equal(first.idempotencyKey, second.idempotencyKey)
  assert.equal(first.payload.dedupeKey, second.payload.dedupeKey)
})
