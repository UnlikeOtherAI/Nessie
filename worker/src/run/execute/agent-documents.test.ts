import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasDocumentsPromptTools,
  hasKbWriteTools,
  resolveAgentDocumentsHome,
} from './agent-documents.js'

test('document homes are provisioned only for an assembled KB write tool', () => {
  assert.equal(hasKbWriteTools(new Set(['kb_search', 'kb_list'])), false)
  assert.equal(hasKbWriteTools(new Set(['kb_document_compose'])), true)
  assert.equal(hasKbWriteTools(new Set(['kb_document_edit'])), true)
})

test('the documents prompt requires the complete on-demand read toolset', () => {
  const complete = new Set([
    'kb_list',
    'kb_search',
    'kb_page_read',
  ])
  assert.equal(hasDocumentsPromptTools(complete), true)

  for (const missingTool of complete) {
    const partial = new Set(complete)
    partial.delete(missingTool)
    assert.equal(hasDocumentsPromptTools(partial), false, `missing ${missingTool}`)
  }
})

test('a projectless legacy agent still receives its organization-backed documents home', async () => {
  const projectId = '00000000-0000-4000-8000-000000000001'
  const spaceId = '00000000-0000-4000-8000-000000000002'
  const tx = {
    $executeRaw: async () => undefined,
    agent: {
      findFirst: async () => ({ systemManaged: false }),
    },
    knowledgeSpace: {
      findFirst: async ({ select }: { select: Record<string, boolean> }) =>
        select.projectId ? null : { id: spaceId },
    },
    project: {
      findFirst: async () => ({ id: projectId }),
    },
  }
  const prisma = {
    ...tx,
    $transaction: async <T>(operation: (client: typeof tx) => Promise<T>) => operation(tx),
  }

  const home = await resolveAgentDocumentsHome(prisma as never, {
    agentId: '00000000-0000-4000-8000-000000000003',
    agentName: 'Legacy agent',
    organizationId: '00000000-0000-4000-8000-000000000004',
    projectId: null,
  })

  assert.deepEqual(home, { spaceId, title: 'Legacy agent — Documents' })
})
