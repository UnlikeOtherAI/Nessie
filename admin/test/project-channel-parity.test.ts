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

test('the Projects sidebar is built from the same rows as the Channels sidebar', () => {
  const projectsNav = source('layouts/admin-shell/ProjectsSidebarNav.tsx')
  const channelsProjects = source('layouts/admin-shell/SidebarProjectsSection.tsx')
  const channelsStarred = source('layouts/admin-shell/SidebarStarredSection.tsx')

  // One row component and one section header for both sidebars, so a project
  // row is the same size, weight and shape wherever it is drawn.
  for (const nav of [projectsNav, channelsProjects]) {
    assert.match(nav, /from '\.\/SidebarMenuSection'/)
    assert.match(nav, /admin-sb-item sidebar-project-tile group/)
    assert.match(nav, /className="sidebar-project-link"/)
    assert.match(nav, /admin-sb-item sidebar-child group/)
    assert.match(nav, /sidebar-row-star/)
    // The disclosure chevron is the shared inline SVG, not a per-sidebar glyph.
    assert.match(nav, /d="M19 9l-7 7-7-7"/)
  }

  // Starred sits above the list it draws from, in both sidebars.
  for (const nav of [projectsNav, channelsStarred]) {
    assert.match(nav, /title="Starred"/)
    assert.match(nav, /<polygon points="12 2 15\.09 8\.26 22 9\.27/)
  }
  assert.ok(
    projectsNav.indexOf('title="Starred"') < projectsNav.indexOf('title="Projects"'),
    'Starred is drawn above Projects',
  )

  // Starring promotes a project out of the list below rather than copying it,
  // exactly as the Channels sidebar lifts a starred channel or project.
  assert.match(
    projectsNav,
    /const unstarredProjects = projects\.filter\(\(project\) => !starredProjectIds\.has\(project\.id\)\)/,
  )
  assert.match(projectsNav, /unstarredProjects\.map\(\(project\) => renderProjectRow\(project, 'projects'\)\)/)
  assert.match(
    source('layouts/admin-shell/useSidebarTree.ts'),
    /\.filter\(\(project\) => !starredProjectIds\.has\(project\.id\)\)/,
  )
})

test('every project section is reachable from the Projects sidebar', () => {
  const sections = source('navigation/project-sections.ts')
  const projectsNav = source('layouts/admin-shell/ProjectsSidebarNav.tsx')
  const surfaces = source('navigation/surfaces.ts')

  // The sidebar is now the only doorway to a project's sections, so the list it
  // renders has to name every routed section (AGENTS.md -> "Rule zero").
  for (const id of ['overview', 'board', 'backlog', 'insights', 'docs', 'executors', 'settings']) {
    assert.ok(sections.includes(`id: '${id}'`), `project-sections is missing ${id}`)
  }
  // ... and the router has to answer every path the list produces.
  const routed = /board\|backlog\|insights\|docs\|executors\|settings/
  assert.match(surfaces, routed)
  assert.match(projectsNav, /projectSections\(\{ assignedWorkCount, isScrum, knowledgeCount, projectId \}\)/)
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
