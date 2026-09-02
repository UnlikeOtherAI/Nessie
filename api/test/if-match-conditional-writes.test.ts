import assert from 'node:assert/strict'
import test from 'node:test'

import type { FastifyRequest } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { readIfMatchRevision } from '../src/lib/if-match.js'
import {
  updateWorkflowTemplate,
  WorkflowTemplateVersionConflictError,
} from '../src/services/workflow-templates.js'

// Auto-saving editors cannot ask "are you sure you want to overwrite?", so they
// state which revision they edited and the server refuses a stale save. The
// header is the only place that decision is read from, and it fails closed on
// anything it cannot parse rather than quietly saving unconditionally.

const withHeader = (value: string | string[] | undefined): FastifyRequest =>
  ({ headers: { 'if-match': value } }) as unknown as FastifyRequest

test('If-Match parses a bare, quoted, and weak revision the same way', () => {
  assert.deepEqual(readIfMatchRevision(withHeader('7')), { kind: 'revision', revision: 7 })
  assert.deepEqual(readIfMatchRevision(withHeader('"7"')), { kind: 'revision', revision: 7 })
  assert.deepEqual(readIfMatchRevision(withHeader('W/"7"')), { kind: 'revision', revision: 7 })
  assert.deepEqual(readIfMatchRevision(withHeader(' 7 ')), { kind: 'revision', revision: 7 })
})

test('a missing header, an empty one, and `*` all mean "no opinion"', () => {
  assert.deepEqual(readIfMatchRevision(withHeader(undefined)), { kind: 'absent' })
  assert.deepEqual(readIfMatchRevision(withHeader('   ')), { kind: 'absent' })
  assert.deepEqual(readIfMatchRevision(withHeader('*')), { kind: 'absent' })
})

test('an unparseable If-Match is refused, never treated as absent', () => {
  // Treating it as absent would turn a client bug into a silent overwrite.
  assert.deepEqual(readIfMatchRevision(withHeader('abc')), { kind: 'malformed' })
  assert.deepEqual(readIfMatchRevision(withHeader('"3-etag"')), { kind: 'malformed' })
  assert.deepEqual(readIfMatchRevision(withHeader('-1')), { kind: 'malformed' })
  assert.deepEqual(readIfMatchRevision(withHeader('9999999999999999999999')), {
    kind: 'malformed',
  })
})

// ─── Workflow templates ────────────────────────────────────────────────────

const actorContext = {
  actor: { actorId: '00000000-0000-4000-8000-000000000b01', actorType: 'user' },
  tenant: { organizationId: '00000000-0000-4000-8000-000000000a01' },
} as unknown as AuthorizedActionContext

const makeWorkflowPrisma = (version: number) => {
  const calls = { updates: 0 }
  const prisma = {
    workflowTemplate: {
      findFirst: async () => ({ id: '00000000-0000-4000-8000-000000000f01', version }),
      update: async () => {
        calls.updates += 1
        return {
          bindingSchema: {},
          createdAt: new Date(),
          demonstrationId: null,
          description: null,
          graphJson: { steps: [{ id: 'step-1', input: { expression: 'trigger' }, title: 'Step one', type: 'transform' }] },
          id: '00000000-0000-4000-8000-000000000f01',
          name: 'Nightly sweep',
          organizationId: '00000000-0000-4000-8000-000000000a01',
          requiredEnvironmentTemplateIds: [],
          source: 'authored',
          stepSamples: {},
          triggersJson: {},
          updatedAt: new Date(),
          variableSchema: {},
          version: version + 1,
        }
      },
    },
    agent: { findMany: async () => [] },
    executionEnvironmentTemplate: { findMany: async () => [] },
  } as unknown as PrismaClient
  return { calls, prisma }
}

const graph = { steps: [{ id: 'step-1', input: { expression: 'trigger' }, title: 'Step one', type: 'transform' }] } as never

test('a workflow save that names the current version goes through', async () => {
  const { calls, prisma } = makeWorkflowPrisma(4)
  const saved = await updateWorkflowTemplate(
    prisma,
    actorContext,
    'wf-1',
    { graph, name: 'Nightly sweep' },
    4,
  )
  assert.equal(saved?.version, 5)
  assert.equal(calls.updates, 1)
})

test('a workflow save from a stale editor is refused and writes nothing', async () => {
  const { calls, prisma } = makeWorkflowPrisma(6)
  await assert.rejects(
    updateWorkflowTemplate(prisma, actorContext, 'wf-1', { graph, name: 'Nightly sweep' }, 4),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowTemplateVersionConflictError)
      // The current version travels with the refusal so the client can offer
      // "take theirs" without a second round trip.
      assert.equal(error.currentVersion, 6)
      return true
    },
  )
  assert.equal(calls.updates, 0)
})

test('a save with no expected version still overwrites — that is the explicit choice', async () => {
  const { calls, prisma } = makeWorkflowPrisma(6)
  const saved = await updateWorkflowTemplate(
    prisma,
    actorContext,
    'wf-1',
    { graph, name: 'Nightly sweep' },
  )
  assert.equal(saved?.version, 7)
  assert.equal(calls.updates, 1)
})
