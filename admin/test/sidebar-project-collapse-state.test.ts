import assert from 'node:assert/strict'
import test from 'node:test'
import type { SidebarProject } from '../src/layouts/admin-shell/types'
import {
  expandCollapsedProject,
  parseCollapsedProjectIds,
  retainCollapsedProjectIds,
  serializeCollapsedProjectIds,
} from '../src/layouts/admin-shell/SidebarProjectsSection'

const sidebarProjects = (ids: string[]): SidebarProject[] =>
  ids.map((id) => ({ id } as SidebarProject))

test('collapsed project state accepts only serialized project ids', () => {
  assert.deepEqual(
    [...parseCollapsedProjectIds('["project-a", 7, "project-a", null]')],
    ['project-a'],
  )
  assert.deepEqual([...parseCollapsedProjectIds('not-json')], [])
  assert.deepEqual([...parseCollapsedProjectIds('{"project-a":true}')], [])
})

test('collapsed project state removes deleted projects before persisting', () => {
  const retained = retainCollapsedProjectIds(
    new Set(['project-a', 'removed-project', 'project-b']),
    sidebarProjects(['project-a', 'project-b']),
  )

  assert.deepEqual([...retained], ['project-a', 'project-b'])
  assert.equal(serializeCollapsedProjectIds(retained), '["project-a","project-b"]')
})

test('a channel added to a closed project opens it', () => {
  const collapsed = new Set(['project-a', 'project-b'])

  assert.deepEqual(
    [...expandCollapsedProject(collapsed, 'project-a')],
    ['project-b'],
  )
})

test('opening a project that is already open changes nothing at all', () => {
  const collapsed = new Set(['project-a'])

  // Identity, not equality: the effect skips the state write and the cookie on
  // this, so a new Set here would be a render loop rather than a no-op.
  assert.equal(expandCollapsedProject(collapsed, 'project-b'), collapsed)
})
