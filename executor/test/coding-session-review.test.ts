import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { gitStartSnapshot, reviewCodingSession } from '../src/coding-session/review.js'
import { initialCodingSessionState } from '../src/coding-session/types.js'
import { initRepository } from './coding-session-harness.js'

/** The review over a real git repository: what changed since the session started, worktrees included. */
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
  cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
})

test('the review reports commits, diff, uncommitted work and the worktrees created since the start', { timeout: 60_000 }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-review-')))
  try {
    const root = join(dir, 'repo')
    await initRepository(root)
    await writeFile(join(root, '.git', 'info', 'exclude'), '.worktrees/\n')
    const existing = join(root, '.worktrees', 'before')
    git(root, ['worktree', 'add', '-q', '-b', 'before', existing])
    const snapshot = await gitStartSnapshot(root)
    assert.match(snapshot.baseCommit ?? '', /^[0-9a-f]{40}$/u)
    assert.equal(snapshot.branch, 'main')
    assert.equal(snapshot.worktreesAtStart?.length, 2)
    await writeFile(join(root, 'feature.ts'), 'export const a = 1\n')
    git(root, ['add', 'feature.ts'])
    git(root, ['commit', '-q', '-m', 'add the feature'])
    await writeFile(join(root, 'README.md'), 'changed\n')
    await writeFile(join(root, 'scratch.txt'), 'untracked\n')
    const created = join(root, '.worktrees', 'agent-work')
    git(root, ['worktree', 'add', '-q', '-b', 'agent/fix', created])
    await writeFile(join(created, 'wip.ts'), 'x\n')
    const state = { ...initialCodingSessionState('2026-09-22T00:00:00.000Z'), ...snapshot, lastTest: { command: 'pnpm test', exitCode: 0 } }
    const review = await reviewCodingSession({
      folder: root, rootCanonical: root, state, run: undefined,
      rewriter: createPathRewriter([{ name: 'repo', paths: [root] }, { name: undefined, paths: [dir] }]),
    })
    assert.equal(review.branch, 'main')
    assert.deepEqual((review.commitsSinceStart as string[]).map((line) => line.replace(/^[0-9a-f]+ /u, '')), ['add the feature'])
    assert.ok((review.diffStat as string[]).some((line) => line.includes('feature.ts')))
    assert.equal(review.uncommitted, 1)
    assert.equal(review.untracked, 1)
    assert.deepEqual(review.worktreesCreatedSinceStart, [{
      path: '<repo>/.worktrees/agent-work', branch: 'agent/fix', commitsSinceStart: 1, uncommitted: 0, untracked: 1,
    }])
    assert.deepEqual(review.lastTest, { command: 'pnpm test', exitCode: 0 })
    assert.equal(JSON.stringify(review).includes(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
