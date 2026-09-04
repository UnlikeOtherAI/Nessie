#!/usr/bin/env node

// Migration lint gate.
//
// Hard fail: any migration folder that exists at the merge-base with the base
// branch must still exist in the worktree, byte-identical. Renaming,
// renumbering, or deleting an already-committed migration breaks
// `prisma migrate deploy` for every database that has the old row recorded in
// `_prisma_migrations` (checksum mismatch / missing migration), so it is
// rejected here before it can ship.
//
// Warning only: CREATE INDEX without CONCURRENTLY on known-large tables
// (messages, task_events, runs, audit_logs) in migrations added by this
// branch. These lock the table for the duration of the build and deserve
// human review, but small installs tolerate them, so they are listed, not
// failed.
//
// Warning only: statements that are incompatible with a rolling deploy —
// RENAME COLUMN/TABLE, ALTER TYPE ... RENAME VALUE, DROP COLUMN, and
// SET NOT NULL. `infrastructure/compose/redeploy.sh` migrates first, then runs
// the new replica *alongside* the old one until it is healthy, so between
// those two steps the previous image is serving traffic against the new
// schema. A rename is invisible to this gate but fatal to that window: on
// 2026-09-03 `20260903150000_workspace_to_team_vocabulary` renamed
// `teams.external_workspace_id` and three enum values in the same change as
// the 99 source files that used them, so every old-replica query touching
// them failed until the swap completed. Expand/contract (add new, dual-write,
// backfill, drop later) avoids it; these are warnings because the two-deploy
// pattern is a judgement call, not a rule a script can make.
//
// Base ref resolution: $MIGRATION_LINT_BASE, else origin/$GITHUB_BASE_REF
// (pull requests), else origin/main, else local `main`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.join('api', 'prisma', 'migrations');
const LARGE_TABLES = ['messages', 'task_events', 'runs', 'audit_logs'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

function fail(message) {
  console.error(`lint-migrations: ${message}`);
  process.exit(1);
}

function resolveBase() {
  const candidates = [];
  if (process.env.MIGRATION_LINT_BASE) candidates.push(process.env.MIGRATION_LINT_BASE);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    try {
      return git(['merge-base', 'HEAD', ref]);
    } catch {
      // ref not available; try the next candidate
    }
  }
  fail(`could not resolve a merge-base against any of: ${candidates.join(', ')}`);
}

// Names of migration directories present at a git ref.
function migrationsAtRef(ref) {
  const tree = git(['ls-tree', `${ref}:api/prisma/migrations`]);
  return tree
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)) // "<mode> <type> <sha>\t<name>"
    .filter((fields) => fields[1] === 'tree' && /^\d+_/.test(fields[3]))
    .map((fields) => fields[3]);
}

function currentMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => entry.name);
}

// True when the worktree (including uncommitted changes) differs from base
// for anything under the given migration folder.
function differsFromBase(base, name) {
  const status = git(['status', '--porcelain', '--', path.join(MIGRATIONS_DIR, name)]);
  if (status) return true;
  try {
    execFileSync('git', ['diff', '--quiet', base, '--', path.join(MIGRATIONS_DIR, name)]);
    return false;
  } catch {
    return true;
  }
}

function nonConcurrentIndexWarnings(sql, migrationName) {
  const warnings = [];
  const statements = sql.split(';');
  for (const statement of statements) {
    if (!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(statement)) continue;
    if (/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(statement)) continue;
    for (const table of LARGE_TABLES) {
      const onTable = new RegExp(`\\bON\\s+(ONLY\\s+)?(\\w+\\.)?"?${table}"?\\s*\\(`, 'i');
      if (onTable.test(statement)) {
        warnings.push(`${migrationName}: non-CONCURRENTLY index on ${table}: ${statement.trim().split('\n')[0]}`);
      }
    }
  }
  return warnings;
}

/**
 * Statements that break while an old replica still serves the previous schema.
 *
 * Deliberately syntactic and deliberately noisy-on-the-side-of-caution: it
 * reports the statement so a human can decide whether the column or value is
 * one the running image reads. A migration that genuinely needs a rename can
 * carry it in two deploys instead.
 */
const ROLLING_DEPLOY_HAZARDS = [
  { label: 'RENAME COLUMN', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+COLUMN\b/i },
  { label: 'RENAME TABLE', pattern: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[^;]*?\bRENAME\s+TO\b/i },
  { label: 'RENAME enum value', pattern: /\bALTER\s+TYPE\b[\s\S]*?\bRENAME\s+VALUE\b/i },
  { label: 'DROP COLUMN', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
  { label: 'SET NOT NULL', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bSET\s+NOT\s+NULL\b/i },
];

function rollingDeployWarnings(sql, migrationName) {
  const warnings = [];
  for (const statement of sql.split(';')) {
    // A rename inside a comment is documentation, not DDL.
    const code = statement.replace(/--[^\n]*/g, '');
    if (!code.trim()) continue;
    for (const { label, pattern } of ROLLING_DEPLOY_HAZARDS) {
      if (!pattern.test(code)) continue;
      const first = code.trim().split('\n')[0];
      warnings.push(`${migrationName}: ${label} is not rolling-deploy safe: ${first}`);
    }
  }
  return warnings;
}

function main() {
  const base = resolveBase();
  const atBase = migrationsAtRef(base);
  const current = new Set(currentMigrations());

  const violations = [];
  for (const name of atBase) {
    if (!current.has(name)) {
      violations.push(`${name}: present at merge-base but missing in worktree (renamed, renumbered, or deleted?)`);
    } else if (differsFromBase(base, name)) {
      violations.push(`${name}: content differs from merge-base; committed migrations are immutable`);
    }
  }

  const warnings = [];
  const rollingWarnings = [];
  const baseSet = new Set(atBase);
  for (const name of current) {
    if (baseSet.has(name)) continue; // only review migrations this branch adds
    const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, 'utf8');
    warnings.push(...nonConcurrentIndexWarnings(sql, name));
    rollingWarnings.push(...rollingDeployWarnings(sql, name));
  }

  if (warnings.length > 0) {
    console.warn('lint-migrations: review needed — non-CONCURRENTLY index creation on large tables:');
    for (const warning of warnings) console.warn(`  warning: ${warning}`);
  }

  if (rollingWarnings.length > 0) {
    console.warn('lint-migrations: review needed — statements that break the old replica during a rolling deploy:');
    for (const warning of rollingWarnings) console.warn(`  warning: ${warning}`);
    console.warn('  redeploy.sh migrates before the swap, so the previous image serves traffic against the new schema.');
    console.warn('  Prefer expand/contract: add the new shape, dual-write, backfill, drop the old one in a later deploy.');
  }

  if (violations.length > 0) {
    console.error('lint-migrations: immutable-history violations:');
    for (const violation of violations) console.error(`  error: ${violation}`);
    fail(`${violations.length} migration folder(s) renamed, renumbered, deleted, or modified.`);
  }

  console.log(`lint-migrations: ${atBase.length} committed migration(s) intact; ${current.size - baseSet.size} new; ${warnings.length + rollingWarnings.length} warning(s).`);
}

main();
