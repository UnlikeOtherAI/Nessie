import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPathRewriter, HOST_PATH_PLACEHOLDER } from '../src/coding-session/path-rewrite.js'
import { createProjector, exitCodeFromToolResult, looksLikeTestCommand } from '../src/coding-session/projection.js'

const windows = createPathRewriter([
  { name: 'nessie', paths: ['C:/Users/ondre/Projects/Nessie', 'C:\\Users\\ondre\\Projects\\Nessie'] },
  { name: undefined, paths: ['C:\\Users\\ondre', 'C:\\Users\\ondre\\AppData\\Local\\Temp'] },
], 'win32')

const linux = createPathRewriter([
  { name: 'app', paths: ['/home/ondre/src/app'] },
  { name: undefined, paths: ['/home/ondre', '/tmp'] },
], 'linux')

const mac = createPathRewriter([
  { name: 'app', paths: ['/Users/ondre/src/app', '/private/var/folders/x/app'] },
  { name: undefined, paths: ['/Users/ondre'] },
], 'darwin')

test('every Windows spelling of a root becomes <root>/relative', () => {
  for (const spelling of [
    'C:\\Users\\ondre\\Projects\\Nessie\\src\\index.ts',
    'C:/Users/ondre/Projects/Nessie/src/index.ts',
    'c:\\users\\ONDRE\\projects\\nessie\\src\\index.ts',
    '\\\\?\\C:\\Users\\ondre\\Projects\\Nessie\\src\\index.ts',
    '//?/C:/Users/ondre/Projects/Nessie/src/index.ts',
    '/c/Users/ondre/Projects/Nessie/src/index.ts',
    '/mnt/c/Users/ondre/Projects/Nessie/src/index.ts',
    'C:\\\\Users\\\\ondre\\\\Projects\\\\Nessie\\\\src\\\\index.ts',
  ]) {
    assert.equal(windows.rewrite(`edited ${spelling} ok`), 'edited <nessie>/src/index.ts ok', spelling)
  }
  assert.equal(windows.rewrite('cd C:\\Users\\ondre\\Projects\\Nessie'), 'cd <nessie>')
  // A sibling that merely starts with the root's name is not the root.
  assert.equal(windows.rewrite('C:\\Users\\ondre\\Projects\\NessieOld\\a.ts'), HOST_PATH_PLACEHOLDER)
})

test('every other absolute path becomes <host path>, and ordinary text survives', () => {
  assert.equal(windows.rewrite('memory at C:\\Users\\ondre\\.claude\\projects\\x'), `memory at ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(windows.rewrite('D:\\secrets\\key.pem and ~/.claude/settings.json'), `${HOST_PATH_PLACEHOLDER} and ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(windows.rewrite('\\\\server\\share\\file.txt'), HOST_PATH_PLACEHOLDER)
  assert.equal(windows.rewrite('taskkill /T /F and see https://example.com/a/b/c'), 'taskkill /T /F and see https://example.com/a/b/c')
  assert.equal(windows.rewrite('GET /api/runs/:id/cancel returned 404'), 'GET /api/runs/:id/cancel returned 404')
  assert.equal(linux.rewrite('wrote /home/ondre/src/app/lib/x.ts'), 'wrote <app>/lib/x.ts')
  assert.equal(linux.rewrite('cache in /home/ondre/.cache/pnpm and /var/tmp/x'), `cache in ${HOST_PATH_PLACEHOLDER} and ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(linux.rewrite('/home/ondre/SRC/app/x'), HOST_PATH_PLACEHOLDER, 'Linux paths are case-sensitive: not the root')
  assert.equal(linux.rewrite('src/components/Foo.tsx and a/b'), 'src/components/Foo.tsx and a/b')
  assert.equal(mac.rewrite('/private/var/folders/x/app/README.md'), '<app>/README.md')
  assert.equal(mac.rewrite('/users/ONDRE/src/app/README.md'), '<app>/README.md', 'macOS compares case-insensitively')
})

test('each event kind keeps its allowlisted fields at their caps, rewritten', () => {
  const projector = createProjector(windows)
  assert.equal(projector.toolInput('Bash', { command: 'cd C:\\Users\\ondre\\Projects\\Nessie && pnpm test', description: 'x' }), 'cd <nessie> && pnpm test')
  assert.equal(projector.toolInput('Edit', { file_path: 'C:\\Users\\ondre\\Projects\\Nessie\\a.ts', old_string: 'secret' }), '<nessie>/a.ts')
  assert.equal(projector.toolInput('Grep', { pattern: 'TODO', path: 'C:\\Users\\ondre\\Projects\\Nessie' }), 'TODO in <nessie>')
  assert.equal(projector.toolInput('TodoWrite', { todos: [1, 2, 3] }), '3 items')
  assert.equal(projector.toolInput('Bash', { command: 'x'.repeat(1_000) }).length, 300)
  assert.equal(projector.toolResult([{ type: 'text', text: 'y'.repeat(5_000) }], false).length, 300)
  assert.equal(projector.toolResult('z'.repeat(5_000), true).length, 1_000)
  assert.equal(projector.text(`line one\nline two ${'w'.repeat(3_000)}`, 2_000).startsWith('line one\nline two'), true)
  assert.deepEqual(projector.denials([
    { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'rm -rf C:\\Users\\ondre\\Projects\\Nessie' } },
    { nonsense: true },
  ]), [{ tool: 'Bash', summary: 'rm -rf <nessie>' }])
})

test('an account redaction covers every later string, and only real values become one', () => {
  const projector = createProjector(windows)
  projector.redact([undefined, 42, 'ab', '   '])
  assert.equal(projector.line('ab 42 stays', 100), 'ab 42 stays')
  projector.redact(['owner@example.com', "owner@example.com's Organization"])
  assert.equal(
    projector.text("OWNER@example.com's Organization, owner@example.com, C:\\Users\\ondre\\x", 200),
    `<account>, <account>, ${HOST_PATH_PLACEHOLDER}`,
  )
  assert.equal(projector.toolInput('Bash', { command: 'git config user.email owner@example.com' }), 'git config user.email <account>')
})

test('a test command is recognised by the program it runs, with its exit code from the tool result', () => {
  for (const command of ['pnpm test', 'pnpm --filter @nessie/executor test', 'npm run test:unit', 'npx vitest run',
    'cargo test -p x', 'go test ./...', 'node --test test/a.test.ts', 'cd x && pytest -q']) {
    assert.equal(looksLikeTestCommand(command), true, command)
  }
  for (const command of ['git status', 'pnpm build', 'cat test.txt', 'echo testing']) {
    assert.equal(looksLikeTestCommand(command), false, command)
  }
  assert.equal(exitCodeFromToolResult('Exit code 3\nFAIL', true), 3)
  assert.equal(exitCodeFromToolResult('ok', false), 0)
  assert.equal(exitCodeFromToolResult('crashed', true), null)
})
