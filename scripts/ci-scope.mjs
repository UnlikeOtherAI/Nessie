#!/usr/bin/env node

// CI scope resolver.
//
// Decides how much of the monorepo a CI run has to exercise, and emits the
// answer as GitHub Actions step outputs. Every job runs this once and guards
// its expensive steps on the result.
//
// Why this exists rather than `turbo --affected` alone: `--affected` compares
// package directories only. A change to a root file — eslint.config.js,
// tsconfig.base.json, the lockfile, a lint script under scripts/, or the
// workflow itself — selects ZERO packages, which would turn a CI-config change
// into a run that tests nothing while reporting green. Measured against this
// repo: touching .github/workflows/ci.yml selects 1 package (the root), and
// touching tsconfig.base.json selects the same. So any root-level change here
// forces `full` and the `--affected` filter is dropped for that run.
//
// The same rule covers `main`: a push to main always runs everything, because
// its comparison base is itself (zero packages selected) and the Deploy
// workflow ships every main commit.
//
// Outputs (also printed to stderr for local debugging):
//   full          '1' when the whole repo must run; '' otherwise
//   code          '1' when any non-documentation file changed
//   desktop       '1' when the Tauri desktop bundle's inputs changed
//   turbo_scope   '--affected' when narrowing is safe; '' when it is not
//
// Local use: `node scripts/ci-scope.mjs` prints the decision and the reason.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Root-level paths that no package directory owns. A change to any of them
// invalidates the whole graph, so `--affected` must not be trusted.
const GLOBAL_PREFIXES = ['.github/', 'scripts/', 'infrastructure/'];
const GLOBAL_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.js',
  'Makefile',
  '.dockerignore',
  '.markdown-doc-structure-baseline.json',
];

// Paths that cannot change how any code behaves. A run whose diff touches only
// these still lints (the markdown-structure gate lives in root lint) but skips
// the browser suites, the mock-LLM smoke and the desktop bundle.
const DOCS_PREFIXES = ['docs/', 'archive/', 'memory/', 'e2e/notes/', 'e2e/screenshots/'];
const DOCS_SUFFIXES = ['.md'];

// Inputs to `tauri build --bundles deb,appimage`. The bundle takes its
// frontend from https://app.nessie.works, not from a local admin build, so
// admin/api/worker changes cannot affect it. The Rust crate does pull in
// executor/windows-provenance through a Cargo path dependency.
const DESKTOP_PREFIXES = ['desktop/', 'executor/windows-provenance/', 'assets/'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function resolveBase() {
  const candidates = [];
  if (process.env.CI_SCOPE_BASE) candidates.push(process.env.CI_SCOPE_BASE);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    const base = tryGit(['merge-base', 'HEAD', ref]);
    if (base) return { base, ref };
  }
  return { base: null, ref: null };
}

function isGlobal(file) {
  return GLOBAL_FILES.includes(file) || GLOBAL_PREFIXES.some((p) => file.startsWith(p));
}

function isDocs(file) {
  return DOCS_PREFIXES.some((p) => file.startsWith(p)) || DOCS_SUFFIXES.some((s) => file.endsWith(s));
}

function isDesktop(file) {
  return DESKTOP_PREFIXES.some((p) => file.startsWith(p));
}

function decide() {
  const ref = process.env.GITHUB_REF ?? '';
  if (ref === 'refs/heads/main') {
    return { full: true, reason: 'push to main — every commit is deployed, so nothing is narrowed' };
  }

  const { base, ref: baseRef } = resolveBase();
  if (!base) {
    return { full: true, reason: 'no merge-base against origin/main or main (shallow checkout?)' };
  }

  const diff = tryGit(['diff', '--name-only', base, 'HEAD']);
  if (diff === null) {
    return { full: true, reason: `git diff against ${base} failed` };
  }

  const files = diff.split('\n').filter(Boolean);
  if (files.length === 0) {
    return { full: true, reason: `no files differ from ${baseRef}` };
  }

  const globals = files.filter(isGlobal);
  if (globals.length > 0) {
    return {
      full: true,
      files,
      reason: `root-level change, package filtering is not trustworthy: ${globals.slice(0, 5).join(', ')}`,
    };
  }

  return {
    full: false,
    files,
    reason: `${files.length} file(s) changed since ${baseRef}, all inside package directories`,
  };
}

const decision = decide();
const files = decision.files ?? [];
const code = decision.full || files.some((f) => !isDocs(f));
const desktop = decision.full || files.some(isDesktop);

const outputs = {
  full: decision.full ? '1' : '',
  code: code ? '1' : '',
  desktop: desktop ? '1' : '',
  turbo_scope: decision.full ? '' : '--affected',
};

process.stderr.write(`CI scope: ${decision.reason}\n`);
for (const [key, value] of Object.entries(outputs)) {
  process.stderr.write(`  ${key.padEnd(12)} ${value === '' ? '(empty)' : value}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
}
