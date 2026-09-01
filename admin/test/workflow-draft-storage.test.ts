import assert from 'node:assert/strict'
import test from 'node:test'

// W14: drafts are keyed per template — editing template A then opening "new
// workflow" must not hydrate A's nodes. A minimal localStorage stub keeps
// this a pure unit test (no browser).
const store = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  },
}

const {
  clearWorkflowDraft,
  loadWorkflowDraft,
  storeWorkflowDraft,
  workflowDraftStorageKey,
} = await import('../src/lib/workflow-designer/draft-storage')

const draft = (workflowName: string) => ({
  connections: [],
  nodes: [],
  workflowName,
})

test('drafts are scoped per template id', () => {
  store.clear()

  storeWorkflowDraft(draft('Template A'), 'template-a')
  storeWorkflowDraft(draft('New workflow draft'), undefined)

  // "New workflow" sees only its own draft, not template A's.
  assert.equal(loadWorkflowDraft(undefined)?.workflowName, 'New workflow draft')
  assert.equal(loadWorkflowDraft('template-a')?.workflowName, 'Template A')
  // Another template sees nothing.
  assert.equal(loadWorkflowDraft('template-b'), null)

  clearWorkflowDraft('template-a')
  assert.equal(loadWorkflowDraft('template-a'), null)
  assert.equal(loadWorkflowDraft(undefined)?.workflowName, 'New workflow draft')
})

test('the legacy global draft migrates into the new-workflow slot exactly once', () => {
  store.clear()
  store.set(
    'nessie.admin.workflow-designer.draft',
    JSON.stringify(draft('Legacy draft')),
  )

  assert.equal(loadWorkflowDraft('template-a'), null) // not leaked into a template
  assert.equal(loadWorkflowDraft(undefined)?.workflowName, 'Legacy draft')
  assert.equal(store.has('nessie.admin.workflow-designer.draft'), false)
  assert.ok(store.has(workflowDraftStorageKey(undefined)))
})
