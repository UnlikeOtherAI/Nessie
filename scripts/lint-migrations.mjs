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
// Hard fail: any migration in the tree whose statements are incompatible with
// the previous release's Prisma clients (DROP COLUMN, DROP TABLE, SET NOT
// NULL) must be listed in api/prisma/deploy-incompatible-migrations.json.
// `prisma migrate deploy` runs BEFORE the container swap, while the previous
// build's API and worker replicas still serve; the generated client selects
// every scalar column, so a dropped column fails every old replica with P2022
// for the whole build+swap window. The manifest is the drain list
// redeploy.sh reads, so it must cover every incompatible migration in the
// tree — a host several releases behind can have any of them pending — which
// is why this check scans all migrations, not only the ones this branch adds.
//
// Base ref resolution: $MIGRATION_LINT_BASE, else origin/$GITHUB_BASE_REF
// (pull requests), else origin/main, else local `main`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = path.join('api', 'prisma', 'migrations');
const MANIFEST_PATH = path.join('api', 'prisma', 'deploy-incompatible-migrations.json');
const LARGE_TABLES = ['messages', 'task_events', 'runs', 'audit_logs'];

// The clauses that break the previous release's clients while they still
// serve against the migrated schema. Each is matched per statement, after
// comments and string/quoted bodies are stripped, so the words inside a
// comment or literal never trip the gate.
const INCOMPATIBLE_CLAUSES = [
  { label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { label: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
];

// The expand half of the expand/backfill/contract pattern; named in the
// failure message so an author has a working example in-tree.
const EXPAND_CONTRACT_EXAMPLE = '20260911110000_project_team_inversion_expand';

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

// Split a migration into statements with line/block comments removed and the
// contents of single-quoted strings and dollar-quoted bodies blanked, so a
// clause mentioned in prose or seeded data is never mistaken for a schema
// change. Double-quoted identifiers are kept verbatim — the index check below
// matches table names through them. Prisma's own migrations are plain DDL,
// but hand-written repair migrations carry both comments and string data.
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let index = 0;

  const flush = () => {
    if (current.trim().length > 0) statements.push(current);
    current = '';
  };

  while (index < sql.length) {
    const char = sql[index];
    const pair = sql.slice(index, index + 2);

    if (pair === '--') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      current += ' ';
      continue;
    }
    if (pair === '/*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2; // '' is an escaped quote inside a string, not its end
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      current += "''"; // literal contents can never be DDL
      continue;
    }
    if (char === '"') {
      const end = sql.indexOf('"', index + 1);
      if (end === -1) {
        current += sql.slice(index);
        index = sql.length;
        continue;
      }
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
        current += "''"; // function bodies can mention anything
        continue;
      }
    }
    if (char === ';') {
      flush();
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  flush();
  return statements;
}

// The incompatible clauses a migration's SQL actually executes, deduped.
export function incompatibleClauses(sql) {
  const found = new Set();
  for (const statement of splitStatements(sql)) {
    for (const { label, pattern } of INCOMPATIBLE_CLAUSES) {
      if (pattern.test(statement)) found.add(label);
    }
  }
  return [...found];
}

// The violation for a migration that breaks old clients without a drain, or
// null when it is clean or manifest-listed. Exported for the unit test; the
// wording is the author's remediation, so keep it exact.
export function deployCompatibilityViolation(name, sql, manifestNames) {
  const clauses = incompatibleClauses(sql);
  if (clauses.length === 0 || manifestNames.has(name)) return null;
  return `${name}: contains ${clauses.join(', ')} but is not listed in ${MANIFEST_PATH}`;
}

// Read and shape-check the drain manifest. Each entry names a migration that
// the deploy must drain old replicas for, with the reason a future reader
// needs to decide whether theirs belongs too.
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`${MANIFEST_PATH} is missing; redeploy.sh reads it to decide when to drain old replicas before migrating.`);
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    fail(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(entries)) {
    fail(`${MANIFEST_PATH} must be a JSON array of { "migration", "reason" } entries.`);
  }
  for (const entry of entries) {
    if (typeof entry?.migration !== 'string' || !/^\d+_/.test(entry.migration) || typeof entry?.reason !== 'string' || entry.reason.length === 0) {
      fail(`${MANIFEST_PATH}: every entry must be { "migration": "<timestamp>_<name>", "reason": "<why old clients break>" }; got ${JSON.stringify(entry)}`);
    }
  }
  return entries;
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
  for (const statement of splitStatements(sql)) {
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

function main() {
  const base = resolveBase();
  const atBase = migrationsAtRef(base);
  const current = new Set(currentMigrations());
  const manifest = loadManifest();
  const manifestNames = new Set(manifest.map((entry) => entry.migration));

  const historyViolations = [];
  const compatibilityViolations = [];
  for (const name of atBase) {
    if (!current.has(name)) {
      historyViolations.push(`${name}: present at merge-base but missing in worktree (renamed, renumbered, or deleted?)`);
    } else if (differsFromBase(base, name)) {
      historyViolations.push(`${name}: content differs from merge-base; committed migrations are immutable`);
    }
  }

  // A manifest entry naming a migration that does not exist would read as
  // "pending" forever on the host, draining every deploy for nothing — the
  // name comes from redeploy.sh's SQL verbatim, so a typo is downtime.
  for (const entry of manifest) {
    if (!current.has(entry.migration)) {
      compatibilityViolations.push(`${MANIFEST_PATH}: ${entry.migration} has no migration directory; remove the entry or fix the name`);
    }
  }

  for (const name of current) {
    const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const violation = deployCompatibilityViolation(name, fs.readFileSync(sqlPath, 'utf8'), manifestNames);
    if (violation) compatibilityViolations.push(violation);
  }

  const warnings = [];
  const baseSet = new Set(atBase);
  for (const name of current) {
    if (baseSet.has(name)) continue; // only review migrations this branch adds
    const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    warnings.push(...nonConcurrentIndexWarnings(fs.readFileSync(sqlPath, 'utf8'), name));
  }

  if (warnings.length > 0) {
    console.warn('lint-migrations: review needed — non-CONCURRENTLY index creation on large tables:');
    for (const warning of warnings) console.warn(`  warning: ${warning}`);
  }

  if (historyViolations.length > 0) {
    console.error('lint-migrations: immutable-history violations:');
    for (const violation of historyViolations) console.error(`  error: ${violation}`);
  }

  if (compatibilityViolations.length > 0) {
    console.error('lint-migrations: deploy-compatibility violations:');
    for (const violation of compatibilityViolations) console.error(`  error: ${violation}`);
    console.error(
      '\nA migration that drops a column or table, or sets NOT NULL, runs while the previous\n'
      + 'release\'s API and worker replicas still serve; their generated clients fail against\n'
      + 'the new schema for the whole build+swap window. Either split the change into\n'
      + `expand/backfill/contract across two releases (see ${EXPAND_CONTRACT_EXAMPLE}), or add\n`
      + `the migration to ${MANIFEST_PATH} with a reason, so redeploy.sh drains the old\n`
      + 'replicas before applying it.',
    );
  }

  if (historyViolations.length > 0 || compatibilityViolations.length > 0) {
    fail(`${historyViolations.length + compatibilityViolations.length} migration violation(s).`);
  }

  console.log(`lint-migrations: ${atBase.length} committed migration(s) intact; ${current.size - baseSet.size} new; ${manifest.length} deploy-incompatible; ${warnings.length} warning(s).`);
}

// Run only as a script; the test imports the pure functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
