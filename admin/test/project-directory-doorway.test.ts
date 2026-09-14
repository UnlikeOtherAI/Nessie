import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ProjectDirectoryEntrySchema } from '@nessie/schemas'

import { matchSurface } from '../src/navigation/surfaces'

/**
 * Rule zero for the project directory: `GET /api/projects/directory` is only a
 * delivery if a person can reach it and it shows an outsider nothing more than
 * the server sends.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

test('the directory has a route of its own, not a project id', () => {
  const surface = matchSurface('/projects/directory')
  assert.equal(surface?.surface.type, 'detail')
  assert.match(source('router.tsx'), /path: '\/projects\/directory'/)
})

test('the Projects sidebar offers the directory to everyone who sees the list', () => {
  const sidebar = source('layouts/admin-shell/ProjectsSidebarNav.tsx')
  assert.match(sidebar, /to="\/projects\/directory"/)
  assert.match(sidebar, /Browse all projects/)
})

test('the directory page carries no modify control', () => {
  const page = source('pages/project/ProjectDirectoryPage.tsx')
  const modifyControls = [
    /useUpdateProject/,
    /useDeleteProject/,
    /useAddProjectMember/,
    /useRemoveProjectMember/,
    /actions=/,
  ]
  for (const forbidden of modifyControls) {
    assert.doesNotMatch(page, forbidden)
  }
})

test('a limited row cannot carry a withheld field, even if the reader sent one', () => {
  const limited = {
    access: 'limited',
    description: 'Launch planning',
    id: '00000000-0000-4000-8000-000000000001',
    members: [],
    name: 'Launch',
  }
  assert.equal(ProjectDirectoryEntrySchema.safeParse(limited).success, true)
  for (const field of ['memberCount', 'channelCount', 'boards', 'project', 'avatarEmoji']) {
    assert.equal(
      ProjectDirectoryEntrySchema.safeParse({ ...limited, [field]: 1 }).success,
      false,
      `limited rejects ${field}`,
    )
  }
})
