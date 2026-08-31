import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent detail mounts documents through the shared knowledge workspace seam', () => {
  const tabs = readSource('../src/components/features/agents/AgentDetailTabs.tsx')
  const documents = readSource('../src/components/features/agents/AgentDocumentsTab.tsx')
  const projectDocs = readSource('../src/pages/project/ProjectDocsTab.tsx')

  assert.match(tabs, /label: 'Documents', value: 'documents'/)
  assert.match(tabs, /documents: \{/)
  assert.match(documents, /<KnowledgeProvider agentId=\{agent\.id\} spaceId=\{documentsQuery\.data\.space\.id\}>/)
  assert.match(documents, /<KnowledgeWorkspace canManageSpace=\{isOwner\} \/>/)
  assert.match(projectDocs, /<KnowledgeProvider projectId=\{projectId\}>/)
  assert.match(projectDocs, /<KnowledgeWorkspace \/>/)
})

test('agent documents show the honest empty state and no-secrets warning', () => {
  const documents = readSource('../src/components/features/agents/AgentDocumentsTab.tsx')

  assert.match(documents, /has no document space yet/)
  assert.doesNotMatch(documents, /ensure|createSpace|provision/i)
  assert.match(
    documents,
    /These documents are visible to everyone who can see this agent\. Don’t store secrets here\./,
  )
  assert.match(documents, /selectedSpace\.canWrite/)
  assert.match(documents, /Read-only/)
})

test('the knowledge workspace deep-links agent-owned spaces back to their agent', () => {
  const workspace = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')
  const actions = readSource(
    '../src/components/features/knowledge/knowledge-workspace-actions.ts',
  )

  assert.match(workspace, /selectedSpace\?\.ownerAgentId/)
  assert.match(workspace, /navigate\(`\/agents\/\$\{selectedSpace\.ownerAgentId\}`\)/)
  assert.match(actions, /label: 'Open agent'/)
})
