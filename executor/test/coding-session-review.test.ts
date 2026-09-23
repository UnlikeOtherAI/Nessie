import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { rewriteCodingAnswer } from '../src/coding-session/bridge-server.js'
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
    assert.equal(review.staleIndexLock, undefined)
    // A git killed mid-commit leaves index.lock behind; the review says so, since every later git fails on it.
    await writeFile(join(root, '.git', 'index.lock'), '')
    const locked = await reviewCodingSession({
      folder: root, rootCanonical: root, state, rewriter: createPathRewriter([{ name: 'repo', paths: [root] }]),
    })
    assert.equal(locked.staleIndexLock, true)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('branch names and pull-request keys read <user>, while gh is asked by the real name', async () => {
  const worktree = join(tmpdir(), 'nessie-review-wt')
  const asked: string[] = []
  const review = await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(),
    state: { ...initialCodingSessionState('2026-09-23T00:00:00.000Z'), baseCommit: 'a'.repeat(40), worktreesAtStart: [] },
    rewriter: createPathRewriter([], process.platform, { users: ['ondre'], hosts: ['Minis'] }),
    run: async (file, args) => {
      const joined = args.join(' ')
      if (file === 'gh') {
        asked.push(args[2]!)
        return { code: 0, missing: false, stdout: JSON.stringify({ url: 'https://github.com/acme/app/pull/7', state: 'OPEN', statusCheckRollup: [] }) }
      }
      const stdout = joined.includes('--abbrev-ref') ? 'ondre/fix\n'
        : joined.includes('worktree list') ? `worktree ${worktree}\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/ondre/wip\n\n`
          : joined.includes('log --oneline') ? 'abc1234 ondre fixed the build on Minis\n' : ''
      return { code: 0, missing: false, stdout }
    },
  })
  assert.equal(review.branch, '<user>/fix')
  assert.deepEqual(review.commitsSinceStart, ['abc1234 <user> fixed the build on <host>'])
  assert.equal((review.worktreesCreatedSinceStart as { branch: string }[])[0]?.branch, '<user>/wip')
  assert.deepEqual(Object.keys(review.pullRequests as object), ['<user>/fix', '<user>/wip'])
  assert.deepEqual(asked, ['ondre/fix', 'ondre/wip'])
  assert.equal(JSON.stringify(review).toLowerCase().includes('ondre'), false)
})

test('a pull request\'s URL keeps an owner spelled like the OS user, through the review and the last pass', async () => {
  const rewriter = createPathRewriter([], process.platform, { users: ['ondre'], hosts: ['Minis'] })
  const review = await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), rewriter,
    state: { ...initialCodingSessionState('2026-09-23T00:00:00.000Z'), baseCommit: 'a'.repeat(40), worktreesAtStart: [] },
    run: async (file, args) => (file === 'gh'
      ? { code: 0, missing: false, stdout: JSON.stringify({ url: 'https://github.com/ondre/app/pull/7', state: 'OPEN', statusCheckRollup: [] }) }
      : { code: 0, missing: false, stdout: args.includes('--abbrev-ref') ? 'ondre-fix\n' : '' }),
  })
  type Answer = { branch: string; pullRequests: Record<string, { url: string }> }
  const answer = rewriteCodingAnswer(review, rewriter) as Answer
  assert.equal(answer.branch, '<user>-fix')
  assert.deepEqual(Object.values(answer.pullRequests).map((entry) => entry.url), ['https://github.com/ondre/app/pull/7'])
})

test('the review runs git and gh in the environment it is given, never the bridge\'s minimal one', async () => {
  const seen: { file: string; env?: NodeJS.ProcessEnv }[] = []
  await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), state: undefined,
    rewriter: createPathRewriter([]),
    env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/person' },
    run: async (file, args, options) => {
      seen.push({ file, ...(options?.env ? { env: options.env } : {}) })
      return { code: 0, missing: false, stdout: file === 'git' && args.includes('--abbrev-ref') ? 'feature\n' : '' }
    },
  })
  const git = seen.find((call) => call.file === 'git')!
  assert.equal(git.env?.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.deepEqual([git.env?.GIT_OPTIONAL_LOCKS, git.env?.GIT_TERMINAL_PROMPT], ['0', '0'])
  const gh = seen.find((call) => call.file === 'gh')!
  assert.equal(gh.env?.PATH, '/opt/homebrew/bin:/usr/bin', 'Homebrew\'s gh is found the way the person finds it')
  assert.equal(gh.env?.GH_PROMPT_DISABLED, '1')
})
