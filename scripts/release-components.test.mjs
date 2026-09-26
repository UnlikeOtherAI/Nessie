import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildVersion, COMPONENTS, edgeChanges } from './release-components.mjs';

const repositoryDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJson = (path) => JSON.parse(fs.readFileSync(resolve(repositoryDirectory, path), 'utf8'));
const covers = (inputs, path) => inputs.some((input) => (input.endsWith('/') ? path.startsWith(input) : path === input));

function workspaceDirectories() {
  const directories = new Map();
  const roots = ['executor', 'desktop', ...fs.readdirSync(resolve(repositoryDirectory, 'packages'))
    .map((name) => `packages/${name}`)];
  for (const directory of roots) {
    const manifest = resolve(repositoryDirectory, directory, 'package.json');
    if (fs.existsSync(manifest)) directories.set(readJson(`${directory}/package.json`).name, directory);
  }
  return directories;
}

// esbuild bundles whatever the executor imports, so every workspace package in
// its dependency closure is part of what the executor download is built from.
test("the executor's inputs cover every workspace package its runtime is built from", () => {
  const directories = workspaceDirectories();
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name) || !directories.has(name)) return;
    closure.add(name);
    const manifest = readJson(`${directories.get(name)}/package.json`);
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).forEach(visit);
  };
  visit('@nessie/executor');
  assert.ok(closure.size > 1, 'the executor depends on workspace packages');
  for (const name of closure) {
    assert.ok(covers(COMPONENTS.executor.inputs, `${directories.get(name)}/package.json`), name);
  }
});

test('the desktop, which carries the executor runtime, rebuilds whenever the executor would', () => {
  for (const input of COMPONENTS.executor.inputs) {
    assert.ok(COMPONENTS.desktop.inputs.includes(input), input);
  }
});

test('the edge workflow runs for a change to any component input', () => {
  const workflow = fs.readFileSync(resolve(repositoryDirectory, '.github/workflows/windows-edge.yml'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const block = /\n {4}paths:\n((?: {6}- .+\n)+)/.exec(workflow);
  assert.ok(block, 'windows-edge.yml filters its push trigger by path');
  const patterns = [...block[1].matchAll(/- "(.+)"/g)].map((match) => match[1]);
  for (const input of new Set(Object.values(COMPONENTS).flatMap((component) => component.inputs))) {
    assert.ok(patterns.includes(input.endsWith('/') ? `${input}**` : input), input);
  }
  assert.ok(patterns.includes('scripts/release-components.mjs'));
});

function repository(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'nessie-release-components-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const run = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.email', 'release-components@example.invalid');
  run('config', 'user.name', 'Release components test');
  run('config', 'commit.gpgsign', 'false');
  const write = (path, contents) => {
    fs.mkdirSync(join(directory, path, '..'), { recursive: true });
    fs.writeFileSync(join(directory, path), contents);
  };
  const commit = (path, contents) => {
    write(path, contents);
    run('add', '--all');
    run('commit', '--quiet', '-m', `change ${path}`);
    return run('rev-parse', 'HEAD');
  };
  write('executor/package.json', JSON.stringify({ name: '@nessie/executor', version: '0.0.0' }));
  commit('desktop/src-tauri/tauri.conf.json', JSON.stringify({ version: '0.1.1' }));
  return { directory, run, commit };
}

test('a build is numbered by main, keeping the manifest major and minor', (t) => {
  const { directory, commit } = repository(t);
  assert.equal(buildVersion('desktop', directory), '0.1.1');
  commit('desktop/README.md', 'one');
  commit('docs/notes.md', 'two');
  assert.equal(buildVersion('desktop', directory), '0.1.3');
  assert.equal(buildVersion('executor', directory), '0.0.3');
});

test('a merged branch counts once, so a build number never depends on how a branch was cut', (t) => {
  const { directory, run, commit } = repository(t);
  run('switch', '--quiet', '-c', 'feature');
  commit('executor/a.ts', 'a');
  commit('executor/b.ts', 'b');
  run('switch', '--quiet', 'main');
  run('merge', '--quiet', '--no-ff', '-m', 'Merge feature', 'feature');
  assert.equal(buildVersion('executor', directory), '0.0.2');
});

test('a version the manifest cannot express is refused, as is an unknown component', (t) => {
  const { directory, commit } = repository(t);
  commit('desktop/src-tauri/tauri.conf.json', JSON.stringify({ version: '0.1.1-beta.1' }));
  assert.throws(() => buildVersion('desktop', directory), /MAJOR\.MINOR\.PATCH/);
  commit('desktop/src-tauri/tauri.conf.json', JSON.stringify({ version: '256.0.0' }));
  assert.throws(() => buildVersion('desktop', directory), /exceeds Windows Installer/);
  assert.throws(() => buildVersion('mobile', directory), /Unknown release component/);
});

test('a shallow clone is refused rather than numbering a build too low', (t) => {
  const { directory, commit } = repository(t);
  commit('executor/a.ts', 'a');
  const shallow = fs.mkdtempSync(join(tmpdir(), 'nessie-release-components-shallow-'));
  t.after(() => fs.rmSync(shallow, { force: true, recursive: true }));
  // A plain local path ignores --depth; only a file:// URL clones shallowly.
  const source = directory.replaceAll('\\', '/');
  const url = `file://${source.startsWith('/') ? '' : '/'}${source}`;
  execFileSync('git', ['clone', '--quiet', '--depth=1', url, shallow]);
  assert.throws(() => buildVersion('executor', shallow), /fetch-depth: 0/);
});

test('only a component whose inputs changed since its edge build is rebuilt', (t) => {
  const { directory, run, commit } = repository(t);
  const never = edgeChanges(directory);
  assert.equal(never.desktop.changed, true);
  assert.equal(never.executor.changed, true);

  const published = commit('executor/src/index.ts', 'one');
  run('tag', 'desktop-edge', published);
  run('tag', 'executor-edge', published);
  assert.deepEqual(
    Object.values(edgeChanges(directory)).map(({ changed }) => changed),
    [false, false],
  );

  commit('docs/unrelated.md', 'nothing either download is built from');
  commit('desktop/src-tauri/src/lib.rs', 'desktop only');
  const desktopOnly = edgeChanges(directory);
  assert.equal(desktopOnly.desktop.changed, true);
  assert.equal(desktopOnly.executor.changed, false);

  commit('packages/runtime/src/index.ts', 'bundled into the executor runtime');
  const executorInput = edgeChanges(directory);
  assert.equal(executorInput.desktop.changed, true);
  assert.equal(executorInput.executor.changed, true);
});

test('an edge release already ahead of HEAD is never replaced by an older build', (t) => {
  const { directory, run, commit } = repository(t);
  const older = commit('executor/src/index.ts', 'older');
  const newer = commit('executor/src/index.ts', 'newer');
  run('tag', 'executor-edge', newer);
  run('tag', 'desktop-edge', newer);
  run('checkout', '--quiet', older);
  const rerun = edgeChanges(directory);
  assert.equal(rerun.executor.changed, false);
  assert.match(rerun.executor.reason, /not behind HEAD/);
});
