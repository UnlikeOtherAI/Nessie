#!/usr/bin/env node

// Release components: the separately versioned, separately published things
// this repository ships to people's computers.
//
// A component is a name, the files its downloads are built from, and the
// rolling pre-release its edge builds replace. GitHub has no notion of one; it
// is the tag prefix and the input list below, which is what lets a component
// that did not change keep its last build instead of being re-released with
// nothing new in it. docs/plans/2026-09-26-component-releases.md is the model.
//
//   node scripts/release-components.mjs version <component>
//     MAJOR.MINOR from the component's manifest, and main's first-parent commit
//     count as the build number: every build of a later main commit installs
//     over the one before it, which Windows Installer requires and the Tauri
//     updater's SemVer ordering agrees with.
//
//   node scripts/release-components.mjs edge-changes
//     For each component, whether HEAD changed any of its inputs since the
//     commit its edge release was built from. Writes `<component>=1` (or empty)
//     to GITHUB_OUTPUT and prints the reasons.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The standalone executor, and every workspace package its runtime bundle is
// built from (esbuild follows their imports into nessie-executor.cjs). The
// Windows build recipe is an input too: it decides the flags, the signature and
// the version stamped into every file.
const EXECUTOR_INPUTS = [
  '.github/workflows/desktop-windows.yml',
  'executor/',
  'packages/db/',
  'packages/local-inference-host/',
  'packages/runtime/',
  'packages/schemas/',
  'pnpm-lock.yaml',
];

export const COMPONENTS = {
  // Nessie Desktop carries the executor runtime inside it, so every executor
  // input is also a desktop input.
  desktop: {
    manifest: 'desktop/src-tauri/tauri.conf.json',
    edgeTag: 'desktop-edge',
    inputs: ['desktop/', 'assets/', ...EXECUTOR_INPUTS],
  },
  executor: {
    manifest: 'executor/package.json',
    edgeTag: 'executor-edge',
    inputs: EXECUTOR_INPUTS,
  },
};

/** Windows Installer compares major.minor.build and caps them at 255.255.65535. */
const MSI_LIMITS = [255, 255, 65_535];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function component(name) {
  const found = COMPONENTS[name];
  if (!found) {
    throw new Error(`Unknown release component "${name}"; expected one of ${Object.keys(COMPONENTS).join(', ')}.`);
  }
  return found;
}

export function buildVersion(name, cwd = repositoryDirectory) {
  const { manifest } = component(name);
  const declared = JSON.parse(fs.readFileSync(resolve(cwd, manifest), 'utf8')).version;
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(String(declared));
  if (!match) {
    throw new Error(`${manifest} declares version ${declared}; a component version is MAJOR.MINOR.PATCH.`);
  }
  // A shallow clone counts only the commits it fetched, which would number a
  // build lower than the one it replaces.
  if (git(['rev-parse', '--is-shallow-repository'], cwd) === 'true') {
    throw new Error('Build numbers need the full history of main; check out with fetch-depth: 0.');
  }
  const build = Number(git(['rev-list', '--count', '--first-parent', 'HEAD'], cwd));
  const version = [Number(match[1]), Number(match[2]), build];
  version.forEach((part, index) => {
    if (part > MSI_LIMITS[index]) {
      throw new Error(`${name} version ${version.join('.')} exceeds Windows Installer's ${MSI_LIMITS.join('.')}.`);
    }
  });
  return version.join('.');
}

/**
 * Decides, per component, whether HEAD needs a new edge build. The edge tag is
 * moved to the commit each build came from, so it records what is published.
 * A tag HEAD does not contain means a newer build is already out — a re-run of
 * an older workflow run — and the channel never moves backwards.
 */
export function edgeChanges(cwd = repositoryDirectory) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  return Object.fromEntries(Object.entries(COMPONENTS).map(([name, { edgeTag, inputs }]) => {
    const published = tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${edgeTag}^{commit}`], cwd);
    if (!published) {
      return [name, { changed: true, reason: `${edgeTag} has never been published` }];
    }
    if (tryGit(['merge-base', '--is-ancestor', published, head], cwd) === null) {
      return [name, { changed: false, reason: `${edgeTag} is at ${published}, which is not behind HEAD` }];
    }
    const changed = git(['diff', '--name-only', published, head, '--', ...inputs], cwd)
      .split('\n')
      .filter(Boolean);
    return [name, changed.length > 0
      ? { changed: true, reason: `${changed.length} input file(s) changed since ${published}: ${changed.slice(0, 5).join(', ')}` }
      : { changed: false, reason: `no input changed since ${published}` }];
  }));
}

function run([command, name]) {
  if (command === 'version') {
    process.stdout.write(`${buildVersion(name)}\n`);
    return;
  }
  if (command === 'edge-changes') {
    const changes = edgeChanges();
    for (const [component, { changed, reason }] of Object.entries(changes)) {
      process.stderr.write(`${component.padEnd(9)} ${changed ? 'rebuild' : 'keep   '}  ${reason}\n`);
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(changes).map(([component, { changed }]) => `${component}=${changed ? '1' : ''}\n`).join(''),
      );
    }
    return;
  }
  throw new Error('Usage: release-components.mjs version <component> | edge-changes');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2));
}
