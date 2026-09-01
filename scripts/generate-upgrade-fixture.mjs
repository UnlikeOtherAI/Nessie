#!/usr/bin/env node

// Generates the checked-in upgrade-path fixture: a database snapshot at a
// schema N migrations behind HEAD. The fixture lets CI prove the self-host
// upgrade path: restore the snapshot, then `prisma migrate deploy` from HEAD.
//
// How it works:
//   1. Copies prisma/schema.prisma + the first (total - N) migration folders
//      into a temp dir and runs `prisma migrate deploy` against a scratch
//      database, so `_prisma_migrations` checksums match what a real deploy
//      at that cut point would have recorded.
//   2. Dumps the scratch database (schema + the `_prisma_migrations` rows)
//      with pg_dump to a gzipped plain-SQL fixture plus a JSON sidecar with
//      the exact cut point, so future snapshots are reproducible.
//
// Usage:
//   node scripts/generate-upgrade-fixture.mjs [--keep-last 20]
//     [--database-url postgresql://nessie:nessie@localhost:55432/nessie]
//     [--docker nessie-local-postgres]
//
// --docker runs psql/pg_dump inside the named container (for machines without
// local Postgres client binaries); the database itself is never stopped and
// the named database in --database-url is never touched — only a dedicated
// scratch database is created and dropped.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIGRATIONS_DIR = path.join('api', 'prisma', 'migrations');
const FIXTURE_DIR = path.join('api', 'prisma', 'upgrade-fixtures');
const SCRATCH_DB = 'upgrade_ci_fixture_scratch';

function parseArgs(argv) {
  const args = { keepLast: 20, databaseUrl: 'postgresql://nessie:nessie@localhost:55432/nessie', docker: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--keep-last') {
      args.keepLast = Number(value);
    } else if (flag === '--database-url') {
      args.databaseUrl = value;
    } else if (flag === '--docker') {
      args.docker = value;
    } else {
      fail(`Unknown argument: ${flag}`);
    }
    i += 1;
  }
  if (!Number.isInteger(args.keepLast) || args.keepLast < 1) {
    fail('--keep-last must be a positive integer');
  }
  return args;
}

function fail(message) {
  console.error(`generate-upgrade-fixture: ${message}`);
  process.exit(1);
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// Runs a Postgres client command either on the host or inside the container.
// pg_dump/psql accept a connection URL, so no extra env wiring is needed.
function pg(args, commandArgs, { input } = {}) {
  if (args.docker) {
    return execFileSync('docker', ['exec', '-i', args.docker, commandArgs[0], ...commandArgs.slice(1)], {
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return execFileSync(commandArgs[0], commandArgs.slice(1), {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// URLs handed to in-container clients must point at the container's own port.
function clientUrl(args, dbName) {
  const url = new URL(args.databaseUrl);
  url.pathname = `/${dbName}`;
  if (args.docker) {
    url.hostname = 'localhost';
    url.port = '5432';
  }
  return url.toString();
}

function stageBaselineMigrations(baseline) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'nessie-upgrade-fixture-'));
  fs.copyFileSync(path.join('api', 'prisma', 'schema.prisma'), path.join(staging, 'schema.prisma'));
  fs.mkdirSync(path.join(staging, 'migrations'));
  fs.copyFileSync(
    path.join(MIGRATIONS_DIR, 'migration_lock.toml'),
    path.join(staging, 'migrations', 'migration_lock.toml'),
  );
  for (const name of baseline) {
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(staging, 'migrations', name), { recursive: true });
  }
  return staging;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const migrations = listMigrations();
  if (migrations.length <= args.keepLast) {
    fail(`only ${migrations.length} migrations exist; --keep-last ${args.keepLast} leaves no baseline`);
  }
  const baseline = migrations.slice(0, migrations.length - args.keepLast);
  const through = baseline[baseline.length - 1];

  const staging = stageBaselineMigrations(baseline);
  const scratchUrl = clientUrl(args, SCRATCH_DB);
  try {
    console.log(`Replaying ${baseline.length} migrations (through ${through}) into scratch db ${SCRATCH_DB}...`);
    pg(args, ['psql', clientUrl(args, 'postgres'), '-v', 'ON_ERROR_STOP=1', '-q', '-c', `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`]);
    pg(args, ['psql', clientUrl(args, 'postgres'), '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE ${SCRATCH_DB}`]);

    const prismaBin = [
      path.join('api', 'node_modules', '.bin', 'prisma'),
      path.join('node_modules', '.bin', 'prisma'),
    ].find((candidate) => fs.existsSync(candidate));
    if (!prismaBin) fail('prisma CLI not found; run pnpm install first');
    execFileSync(prismaBin, ['migrate', 'deploy', '--schema', path.join(staging, 'schema.prisma')], {
      env: { ...process.env, DATABASE_URL: new URL(args.databaseUrl).toString().replace(/\/[^/]*$/, `/${SCRATCH_DB}`) },
      stdio: 'inherit',
    });

    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const dump = pg(args, ['pg_dump', scratchUrl, '--no-owner', '--no-privileges', '--inserts']);
    const fixturePath = path.join(FIXTURE_DIR, 'baseline.sql.gz');
    execSync(`gzip -9 > ${fixturePath}`, { input: dump, maxBuffer: 64 * 1024 * 1024 });

    const metadata = {
      purpose: 'Upgrade-path CI fixture: schema snapshot this many migrations behind HEAD',
      through,
      baselineMigrations: baseline.length,
      deferredMigrations: args.keepLast,
      totalMigrationsAtGeneration: migrations.length,
      generatedAt: new Date().toISOString(),
      regenerate: `node scripts/generate-upgrade-fixture.mjs --keep-last ${args.keepLast}`,
    };
    fs.writeFileSync(path.join(FIXTURE_DIR, 'baseline.json'), `${JSON.stringify(metadata, null, 2)}\n`);

    const sizeKb = Math.round(fs.statSync(fixturePath).size / 1024);
    console.log(`Fixture written: ${fixturePath} (${sizeKb} KiB gzipped, ${dump.length} bytes raw)`);
    console.log(`Cut point: ${through} (${args.keepLast} migrations deferred to the upgrade replay)`);
  } finally {
    try {
      pg(args, ['psql', clientUrl(args, 'postgres'), '-q', '-c', `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`]);
    } catch {
      console.error(`warning: could not drop scratch db ${SCRATCH_DB}; drop it manually`);
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main();
