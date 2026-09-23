import assert from 'node:assert/strict'
import { hostname, userInfo } from 'node:os'
import { test } from 'node:test'

import { identityNames, readHostIdentity } from '../src/coding-session/host-identity.js'
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

test('a directory name with spaces leaves no tail of itself behind', () => {
  assert.equal(windows.rewrite('read C:\\Users\\Other Person\\AppData\\x.json now'), `read ${HOST_PATH_PLACEHOLDER} now`)
  assert.equal(windows.rewrite('ran C:\\Program Files\\Git\\bin\\bash.exe -lc'), `ran ${HOST_PATH_PLACEHOLDER} -lc`)
  assert.equal(linux.rewrite('wrote /home/jane doe/x and left'), `wrote ${HOST_PATH_PLACEHOLDER} and left`)
  assert.equal(windows.rewrite('edited C:\\Users\\ondre\\Projects\\Nessie\\My Docs\\a.md'), 'edited <nessie>/My Docs/a.md')
  // Prose after a path is still prose.
  assert.equal(windows.rewrite('see D:\\work\\a.ts and b.ts'), `see ${HOST_PATH_PLACEHOLDER} and b.ts`)
})

test('credentials read <secret>, whether the host knows the value or only its shape', () => {
  const projector = createProjector(windows)
  projector.redactSecrets(['configured-secret-value', 'short'])
  const token = `ghp_${'A1b2'.repeat(9)}`
  assert.equal(projector.toolInput('Bash', { command: `export GH_TOKEN=${token}` }), 'export GH_TOKEN=<secret>')
  assert.equal(projector.toolResult(`${token}\n`, false), '<secret>')
  assert.equal(projector.toolInput('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://x' }),
    'curl -H "Authorization: Bearer <secret>" https://x')
  assert.equal(projector.line(`key sk-ant-api03-${'x'.repeat(30)} and AKIAABCDEFGHIJKLMNOP`, 300), 'key <secret> and <secret>')
  assert.equal(projector.line(`jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`, 300), 'jwt <secret>')
  assert.equal(projector.line('DB_PASSWORD="hunter2hunter2" API_KEY: abcdef123', 300), 'DB_PASSWORD=<secret> API_KEY: <secret>')
  assert.equal(projector.text('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----', 300), '<secret>')
  assert.equal(projector.line('uses configured-secret-value; short stays', 300), 'uses <secret>; short stays')
  assert.equal(projector.line('git status and pnpm test passed', 300), 'git status and pnpm test passed')
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

const identity = { users: ['ondre'], hosts: ['Minis', 'Minis.local'] }
const named = createPathRewriter([
  { name: 'nessie', paths: ['C:\\Users\\ondre\\Projects\\Nessie'] },
  { name: undefined, paths: ['C:\\Users\\ondre'] },
], 'win32', identity)

test('the OS user and host read <user> and <host> in what git, npm and a shell print', () => {
  const projector = createProjector(named)
  assert.equal(
    projector.toolResult("Exit code 128\nAuthor identity unknown\nfatal: unable to auto-detect email address (got 'ondre@Minis.(none)')", true),
    "Exit code 128 Author identity unknown fatal: unable to auto-detect email address (got '<user>@<host>.(none)')",
  )
  assert.equal(projector.line('npm notice Logged in as ondre on https://registry.npmjs.org/.', 200),
    'npm notice Logged in as <user> on https://registry.npmjs.org/.')
  assert.equal(projector.line('ONDRE@MINIS MINGW64 ~/Projects/Nessie (main)\n$ whoami\nminis\\ondre', 200),
    `<user>@<host> MINGW64 ${HOST_PATH_PLACEHOLDER} (main) $ whoami <host>\\<user>`)
  assert.equal(projector.line('ssh ondre@minis.local uptime', 200), 'ssh <user>@<host> uptime', 'the FQDN is one host')
  // Paths first: a path under the root keeps its root, and the profile is still a host path.
  assert.equal(projector.line('edited C:\\Users\\ondre\\Projects\\Nessie\\src\\ondre.ts and C:\\Users\\ondre\\x', 200),
    `edited <nessie>/src/<user>.ts and ${HOST_PATH_PLACEHOLDER}`)
})

test('only whole words are names, and a name that is an ordinary word or too short is left alone', () => {
  const words = createPathRewriter([], 'linux', { users: ['dan', 'jo', 'root'], hosts: ['mini', 'localhost'] })
  assert.equal(words.rewrite('redundant Dante danced; minimal minis minion'), 'redundant Dante danced; minimal minis minion')
  assert.equal(words.rewrite('Dan pushed from mini, dan_x stays, dan-x does not'), '<user> pushed from <host>, dan_x stays, <user>-x does not')
  assert.equal(words.rewrite('jo ran it as root on localhost:3000'), 'jo ran it as root on localhost:3000')
  // Placeholders already written, and session ids, are never rewritten again.
  const awkward = createPathRewriter([{ name: 'repo', paths: ['/home/repo/src'] }, { name: undefined, paths: ['/home/repo'] }], 'linux', {
    users: ['repo', 'account'], hosts: ['host', 'cafe'],
  })
  assert.equal(awkward.rewrite('wrote /home/repo/src/a.ts and /home/repo/b as repo on host'), 'wrote <repo>/a.ts and <host path> as <user> on <host>')
  assert.equal(awkward.rewrite('<account> in session 1234abcd-cafe-4000-8000-000000000000'), '<account> in session 1234abcd-cafe-4000-8000-000000000000')
})

test('the names come from the OS and the environment, each once, in short and domain forms', () => {
  const { users, hosts } = readHostIdentity({
    USERNAME: 'Ondre', USER: 'ondre', LOGNAME: 'x', COMPUTERNAME: 'ONDREJS-WORKSTATION', USERDNSDOMAIN: 'CORP.EXAMPLE.COM',
  }, 'win32')
  assert.equal(users.filter((name) => name.toLowerCase() === 'ondre').length, 1, 'one entry however it is cased')
  assert.equal(users.includes('x'), false, 'too short')
  // The whole name, its NetBIOS form and its domain form.
  for (const name of ['ONDREJS-WORKSTATION', 'ONDREJS-WORKSTA', 'ONDREJS-WORKSTATION.CORP.EXAMPLE.COM']) {
    assert.ok(hosts.includes(name), name)
  }
  // What the OS itself answers arrives however bare the environment is.
  const bare = readHostIdentity({}, 'linux')
  assert.ok(identityNames([userInfo().username]).every((name) => bare.users.includes(name)))
  assert.ok(identityNames([hostname(), hostname().split('.')[0]]).every((name) => bare.hosts.includes(name)))
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
