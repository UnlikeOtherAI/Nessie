import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('Sharing and settings targets the folder the Finder is standing in', () => {
  const workspace = source('../src/components/features/knowledge/KnowledgeWorkspace.tsx')
  const finder = source('../src/components/features/knowledge/finder/DocumentsFinder.tsx')
  const dialog = source('../src/components/features/knowledge/FolderSettingsDialog.tsx')

  assert.match(finder, /activeParentPageId \? pageById\(activeParentPageId\) : undefined/)
  assert.match(workspace, /folder\?\.kind === 'folder'/)
  assert.match(workspace, /<FolderSettingsDialog/)
  assert.match(dialog, /title="Folder settings"/)
  assert.match(dialog, /useRenamePage/)
  assert.doesNotMatch(dialog, /Project Documents|Space settings/)
})

test('space settings reset only when their actual initial values change', () => {
  const settings = source('../src/components/features/knowledge/SpaceSettingsDialog.tsx')

  assert.match(settings, /const initialForm = useMemo/)
  assert.match(settings, /\}, \[initialForm, open\]\)/)
  assert.doesNotMatch(settings, /\}, \[open, space\]\)/)
})

test('a project root uses its project name throughout the document browser', () => {
  const workspace = source('../src/components/features/knowledge/KnowledgeWorkspace.tsx')
  const finder = source('../src/components/features/knowledge/finder/DocumentsFinder.tsx')

  assert.match(workspace, /metadata\?\.projectDocuments === true/)
  assert.match(workspace, /projectRootName=\{projectRootName\}/)
  assert.match(workspace, /spaceDisplayName=\{spaceDisplayName\}/)
  assert.match(finder, /spaceName: spaceDisplayName \?\? knowledge\.selectedSpace\?\.name/)
  assert.match(finder, /rootLabel=\{spaceDisplayName \?\? knowledge\.selectedSpace\?\.name/)
})
