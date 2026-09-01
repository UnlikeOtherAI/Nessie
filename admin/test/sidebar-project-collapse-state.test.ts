import assert from 'node:assert/strict'
import test from 'node:test'
import type { SidebarProject } from '../src/layouts/admin-shell/types'
import {
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
