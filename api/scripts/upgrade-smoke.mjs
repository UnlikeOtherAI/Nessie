#!/usr/bin/env node

// Post-upgrade smoke check: runs against a database that was restored from
// the checked-in baseline fixture (api/prisma/upgrade-fixtures/baseline.sql.gz)
// and then migrated to HEAD with `prisma migrate deploy`.
//
// Asserts:
//   1. Every migration folder on disk has a finished, non-rolled-back row in
//      `_prisma_migrations` (i.e. the upgrade replay applied cleanly).
//   2. Core queries against the tables the API depends on most succeed with
//      the freshly generated Prisma client.
//
// Usage: DATABASE_URL=... node scripts/upgrade-smoke.mjs   (from api/)

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const MIGRATIONS_DIR = path.join('prisma', 'migrations');

function fail(message) {
  console.error(`upgrade-smoke: FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set');
  }

  const expected = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name)).length;

  const prisma = new PrismaClient();
  try {
    const [{ applied }] = await prisma.$queryRaw`SELECT count(*)::int AS applied
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const [{ unfinished }] = await prisma.$queryRaw`SELECT count(*)::int AS unfinished
      FROM _prisma_migrations
      WHERE finished_at IS NULL`;
    const [{ rolledBack }] = await prisma.$queryRaw`SELECT count(*)::int AS "rolledBack"
      FROM _prisma_migrations
      WHERE rolled_back_at IS NOT NULL`;

    if (unfinished > 0) fail(`${unfinished} migration(s) started but never finished`);
    if (rolledBack > 0) fail(`${rolledBack} migration(s) are marked rolled back`);
    if (applied !== expected) {
      fail(`_prisma_migrations has ${applied} applied rows but ${expected} migration folders exist on disk`);
    }
    console.log(`migrations: ${applied}/${expected} applied, none unfinished or rolled back`);

    const counts = {
      users: await prisma.user.count(),
      organizations: await prisma.organization.count(),
      messages: await prisma.message.count(),
      runs: await prisma.run.count(),
      taskEvents: await prisma.taskEvent.count(),
      auditLogs: await prisma.auditLog.count(),
    };
    // Exercise a relation + an indexed ordering, not just table existence.
    await prisma.message.findFirst({
      orderBy: { createdAt: 'desc' },
      include: { thread: true },
    });
    console.log(`core queries OK: ${JSON.stringify(counts)}`);
    console.log('upgrade-smoke: PASS');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
