import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (path: string): string => readFileSync(
  fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
  'utf8',
)

test('project navigation reuses project avatars and exposes only edit/delete in its overflow', () => {
  const sidebar = source('layouts/admin-shell/ProjectsSidebarNav.tsx')

  assert.match(sidebar, /import \{ ProjectAvatar \}/)
  assert.match(sidebar, /<ProjectAvatar/)
  const menu = sidebar.slice(sidebar.indexOf('className="admin-sidebar-menu admin-sidebar-menu-project'))
  assert.match(menu, />\s*Edit\s*</)
  assert.match(menu, />\s*Delete\s*</)
  assert.doesNotMatch(menu, />\s*Members\s*</)
  assert.doesNotMatch(menu, />\s*Settings\s*</)
})

test('the project header is shared by both project doorways and opens the shared members popup', () => {
  const header = source('components/features/projects/ProjectPageHeader.tsx')
  const projectView = source('pages/project/ProjectView.tsx')
  const channelOverview = source('pages/channels/ChannelProjectOverviewPage.tsx')

  assert.match(header, /label: `Members \(\$\{project\.memberCount\}\)`/)
  assert.match(header, /<ProjectMembersDialog/)
  // Props are asserted individually rather than as one line: the project view
  // also passes the board switcher into the header's `tabs` slot, so the call
  // spans several lines. What matters is that it is the shared header, driven
  // by the same actions and project.
  assert.match(projectView, /<ProjectPageHeader/)
  assert.match(projectView, /actions=\{headerActions\}/)
  assert.match(projectView, /project=\{project\}/)
  assert.match(channelOverview, /<ProjectPageHeader project=\{project\}/)
})

test('the project action menu stays above its portal dismiss layer', () => {
  const styles = source('styles.css')
  assert.match(styles, /\.admin-sidebar-menu\.fixed\s*\{\s*z-index:\s*61;/)
})
