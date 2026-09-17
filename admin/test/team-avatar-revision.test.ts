import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { QueryClient, QueryObserver } from '@tanstack/react-query'

import { teamKeys } from '../src/facades/team/keys.js'
import { teamAvatarRevisionQueryOptions } from '../src/facades/team/hooks.js'
import { TEAM_DIRECTORY_INVALIDATION } from '../src/facades/projects/hooks.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the avatar revision survives a team-directory invalidation', async () => {
  const queryClient = new QueryClient()
  // The upload mutation's bump (facades/team/hooks.ts).
  queryClient.setQueryData(teamKeys.avatarRevision, 1)
  // The shell's TeamSwitcher keeps this query ALWAYS active, and an
  // invalidation refetches active queries regardless of staleTime — so a
  // prefix invalidation of ['teams'] refetches the revision query, whose
  // constant queryFn resets the cache-buster to 0 and repaints the
  // pre-upload avatar. The directory invalidation must be exact.
  const observer = new QueryObserver(queryClient, teamAvatarRevisionQueryOptions())
  const unsubscribe = observer.subscribe(() => {})
  try {
    await queryClient.invalidateQueries(TEAM_DIRECTORY_INVALIDATION)
    assert.equal(queryClient.getQueryData(teamKeys.avatarRevision), 1)
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('the directory invalidation still matches the team list itself', () => {
  // The team list's own key IS teamKeys.all, so exact: true does not starve
  // the list the mutations exist to refresh.
  assert.deepEqual(TEAM_DIRECTORY_INVALIDATION.queryKey, teamKeys.all)
  assert.equal(TEAM_DIRECTORY_INVALIDATION.exact, true)
})

test('no team mutation invalidates the teams root without exact', () => {
  const source = readSource('../src/facades/projects/hooks.ts')
  const rootInvalidations =
    source.match(/invalidateQueries\(\{[^}]*teamKeys\.all[^}]*\}\)/g) ?? []
  for (const call of rootInvalidations) {
    assert.ok(
      call.includes('exact: true'),
      `non-exact invalidation of the teams root resets the avatar revision: ${call}`,
    )
  }
})
