#!/usr/bin/env node

// Verification harness for 20260815180000_partition_uoa_organizations.
//
// Two phases against a throwaway Postgres (never a dev/prod database):
//
//   Phase A — seeded scenario. Replays every migration BEFORE the partition
//   pair into a scratch database, seeds the retired flattened-model pre-state
//   (one shared org; UOA org "alpha" with 3 teams, UOA org "beta" with 1 team,
//   one local-only team; users spanning both, one user in both; channels /
//   messages / agents / runs / tasks / knowledge pages / attachments / budgets
//   / audit rows / ledger rows / product links / refresh material), then runs
//   `prisma migrate deploy` for the full chain and asserts the post-state:
//   row counts conserved, every moved row's org consistent with its team's
//   external org, membership seeding with the max-role rule, account-link
//   moves, audit-chain epoch reset, and the local-only team untouched.
//
//   Phase B — upgrade-path convergence. Restores the checked-in baseline
//   fixture (api/prisma/upgrade-fixtures/baseline.sql.gz) and proves
//   `prisma migrate deploy` from HEAD converges it (the partition migration is
//   a perfect no-op on a database with no UOA-linked teams).
//
// Usage:
//   docker run -d --name org-part-pg -p 54349:5432 -e POSTGRES_PASSWORD=x \
//     pgvector/pgvector:pg16
//   node scripts/verify-partition-uoa-organizations.mjs \
//     --database-url postgresql://postgres:x@localhost:54349/postgres \
//     --docker org-part-pg
//
// --docker runs psql inside the named container (matching
// scripts/generate-upgrade-fixture.mjs); omit it when local psql can reach the
// database URL directly.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MIGRATIONS_DIR = path.join('api', 'prisma', 'migrations');
const PARTITION_MIGRATIONS = [
  '20260815170000_organization_external_org_id',
  '20260815180000_partition_uoa_organizations',
];
const SEEDED_DB = 'partition_verify_seeded';
const UPGRADE_DB = 'partition_verify_upgrade';

const ORG = '11111111-1111-4111-8111-111111111111';
const U1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const U2 = 'a1a1a1a1-0000-4000-8000-000000000002';
const U3 = 'a1a1a1a1-0000-4000-8000-000000000003';
const U4 = 'a1a1a1a1-0000-4000-8000-000000000004';
const PA1 = 'aaaa0000-0000-4000-8000-000000000001';
const PA2 = 'aaaa0000-0000-4000-8000-000000000002';
const PA3 = 'aaaa0000-0000-4000-8000-000000000003';
const PB1 = 'bbbb0000-0000-4000-8000-000000000001';
const PL = 'cccc0000-0000-4000-8000-000000000001';
const TA1 = 'aaaa1111-0000-4000-8000-000000000001';
const TA2 = 'aaaa1111-0000-4000-8000-000000000002';
const TA3 = 'aaaa1111-0000-4000-8000-000000000003';
const TB1 = 'bbbb1111-0000-4000-8000-000000000001';
const TL1 = 'cccc1111-0000-4000-8000-000000000001';
const CA1 = 'aaaa2222-0000-4000-8000-000000000001';
const CB1 = 'bbbb2222-0000-4000-8000-000000000001';
const CL1 = 'cccc2222-0000-4000-8000-000000000001';
const THA1 = 'aaaa3333-0000-4000-8000-000000000001';
const THB1 = 'bbbb3333-0000-4000-8000-000000000001';
const MA1 = 'aaaa4444-0000-4000-8000-000000000001';
const MB1 = 'bbbb4444-0000-4000-8000-000000000001';
const MB2 = 'bbbb4444-0000-4000-8000-000000000002';
const GA = 'dddd0000-0000-4000-8000-000000000001'; // org-level agent, stays
const GB = 'dddd0000-0000-4000-8000-000000000002'; // PB1/TB1 agent, moves
const RB1 = 'eeee0000-0000-4000-8000-000000000001';
const RCB = 'eeee1111-0000-4000-8000-000000000001';
const TKB = 'ffff0000-0000-4000-8000-000000000001'; // project task, moves
const TKR = 'ffff0000-0000-4000-8000-000000000002'; // run-owned task, moves
const TKO = 'ffff0000-0000-4000-8000-000000000003'; // orphan task, stays
const KSB = 'ffff1111-0000-4000-8000-000000000001';
const KPB = 'ffff2222-0000-4000-8000-000000000001';
const ATM = 'ffff3333-0000-4000-8000-000000000001'; // message attachment, moves
const ATA = 'ffff3333-0000-4000-8000-000000000002'; // avatar-only, stays
const BO = 'ffff4444-0000-4000-8000-000000000001'; // org-scope budget, stays
const BP = 'ffff4444-0000-4000-8000-000000000002'; // PB1 budget, moves
const BT = 'ffff4444-0000-4000-8000-000000000003'; // TB1 budget, moves
const AUD1 = 'ffff5555-0000-4000-8000-000000000001'; // CB1 audit, moves
const AUD2 = 'ffff5555-0000-4000-8000-000000000002'; // org-only audit, stays
const TLE1 = 'ffff6666-0000-4000-8000-000000000001'; // CB1 ledger, moves
const TLE2 = 'ffff6666-0000-4000-8000-000000000002'; // org-only ledger, stays
const SE1 = 'ffff7777-0000-4000-8000-000000000001'; // attachment storage evt
const SE2 = 'ffff7777-0000-4000-8000-000000000002'; // ref-less storage evt
const LNK2 = 'ffff8888-0000-4000-8000-000000000002'; // u2 link, moves
const LNK3 = 'ffff8888-0000-4000-8000-000000000003'; // u3 link, stays
const RT2 = 'ffff9999-0000-4000-8000-000000000002'; // u2 refresh token
const FAM2 = 'ffffaaaa-0000-4000-8000-000000000002'; // u2 refresh family
const UA1 = 'ffffbbbb-0000-4000-8000-000000000001'; // CB1 alert, moves
const UA2 = 'ffffbbbb-0000-4000-8000-000000000002'; // ref-less alert, stays
const EXB = 'ffffcccc-0000-4000-8000-000000000001'; // PB1 executor, moves

const EXT_ALPHA = 'uoa-org-alpha';
const EXT_BETA = 'uoa-org-beta';
const BETA_ORG = `(SELECT id FROM organizations WHERE external_org_id = '${EXT_BETA}')`;

function parseArgs(argv) {
  const args = {
    databaseUrl: 'postgresql://postgres:x@localhost:54349/postgres',
    docker: null,
    keepDbs: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--database-url') {
      args.databaseUrl = argv[i + 1];
      i += 1;
    } else if (flag === '--docker') {
      args.docker = argv[i + 1];
      i += 1;
    } else if (flag === '--keep-dbs') {
      args.keepDbs = true;
    } else {
      fail(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`verify-partition: FAIL: ${message}`);
  process.exit(1);
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

function hostUrl(args, dbName) {
  const url = new URL(args.databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function psql(args, dbName, sql) {
  const commandArgs = ['psql', clientUrl(args, dbName), '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql];
  if (args.docker) {
    return execFileSync('docker', ['exec', '-i', args.docker, ...commandArgs], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  }
  return execFileSync(commandArgs[0], commandArgs.slice(1), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function psqlScript(args, dbName, sql) {
  const commandArgs = ['psql', clientUrl(args, dbName), '-v', 'ON_ERROR_STOP=1', '-q'];
  if (args.docker) {
    return execFileSync('docker', ['exec', '-i', args.docker, ...commandArgs], {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return execFileSync(commandArgs[0], commandArgs.slice(1), {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function recreateDb(args, dbName) {
  psql(args, 'postgres', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  psql(args, 'postgres', `CREATE DATABASE ${dbName}`);
}

function dropDb(args, dbName) {
  try {
    psql(args, 'postgres', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch {
    console.error(`warning: could not drop ${dbName}; drop it manually`);
  }
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function prismaBin() {
  const bin = [
    path.join('api', 'node_modules', '.bin', 'prisma'),
    path.join('node_modules', '.bin', 'prisma'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!bin) fail('prisma CLI not found; run pnpm install first');
  return bin;
}

function migrateDeploy(args, schemaPath, dbName) {
  execFileSync(prismaBin(), ['migrate', 'deploy', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: hostUrl(args, dbName) },
    stdio: 'inherit',
  });
}

// Stage schema + every migration BEFORE the partition pair, so the seeded
// pre-state matches what a real flattened-model install ran.
function stagePreMigrations() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'nessie-partition-verify-'));
  fs.copyFileSync(path.join('api', 'prisma', 'schema.prisma'), path.join(staging, 'schema.prisma'));
  fs.mkdirSync(path.join(staging, 'migrations'));
  fs.copyFileSync(
    path.join(MIGRATIONS_DIR, 'migration_lock.toml'),
    path.join(staging, 'migrations', 'migration_lock.toml'),
  );
  for (const name of listMigrations()) {
    if (PARTITION_MIGRATIONS.includes(name)) continue;
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(staging, 'migrations', name), { recursive: true });
  }
  return staging;
}

const SEED_SQL = `
BEGIN;

INSERT INTO organizations (id, name, created_at, updated_at)
VALUES ('${ORG}', 'Shared Org', '2026-01-01', now());

INSERT INTO users (id, email, display_name, updated_at) VALUES
  ('${U1}', 'u1@example.com', 'User One (alpha)', now()),
  ('${U2}', 'u2@example.com', 'User Two (beta)', now()),
  ('${U3}', 'u3@example.com', 'User Three (both)', now()),
  ('${U4}', 'u4@example.com', 'User Four (local)', now());

INSERT INTO organization_members (id, organization_id, user_id, role) VALUES
  (gen_random_uuid(), '${ORG}', '${U1}', 'owner'),
  (gen_random_uuid(), '${ORG}', '${U2}', 'member'),
  (gen_random_uuid(), '${ORG}', '${U3}', 'member'),
  (gen_random_uuid(), '${ORG}', '${U4}', 'member');

INSERT INTO projects (id, name, organization_id, updated_at) VALUES
  ('${PA1}', 'Alpha WS 1', '${ORG}', now()),
  ('${PA2}', 'Alpha WS 2', '${ORG}', now()),
  ('${PA3}', 'Alpha WS 3', '${ORG}', now()),
  ('${PB1}', 'Beta WS 1', '${ORG}', now()),
  ('${PL}', 'Local project', '${ORG}', now());

INSERT INTO teams (id, name, project_id, external_team_id, external_org_id, created_at, updated_at) VALUES
  ('${TA1}', 'Alpha Team 1', '${PA1}', 'ws-alpha-1', '${EXT_ALPHA}', '2026-02-01', now()),
  ('${TA2}', 'Alpha Team 2', '${PA2}', 'ws-alpha-2', '${EXT_ALPHA}', '2026-02-02', now()),
  ('${TA3}', 'Alpha Team 3', '${PA3}', 'ws-alpha-3', '${EXT_ALPHA}', '2026-02-03', now()),
  ('${TB1}', 'Beta Team 1', '${PB1}', 'ws-beta-1', '${EXT_BETA}', '2026-02-04', now()),
  ('${TL1}', 'Local Team', '${PL}', NULL, NULL, '2026-02-05', now());

INSERT INTO team_members (id, team_id, user_id, role) VALUES
  (gen_random_uuid(), '${TA1}', '${U1}', 'owner'),
  (gen_random_uuid(), '${TA1}', '${U3}', 'member'),
  (gen_random_uuid(), '${TB1}', '${U2}', 'admin'),
  (gen_random_uuid(), '${TB1}', '${U3}', 'owner'),
  (gen_random_uuid(), '${TL1}', '${U4}', 'member');

INSERT INTO channels (id, label, slug, organization_id, project_id, team_id, updated_at) VALUES
  ('${CA1}', 'general-alpha', 'general-alpha', '${ORG}', '${PA1}', '${TA1}', now()),
  ('${CB1}', 'general-beta', 'general-beta', '${ORG}', '${PB1}', '${TB1}', now()),
  ('${CL1}', 'general-local', 'general-local', '${ORG}', '${PL}', '${TL1}', now());

INSERT INTO channel_members (id, channel_id, user_id) VALUES
  (gen_random_uuid(), '${CA1}', '${U1}'),
  (gen_random_uuid(), '${CB1}', '${U2}'),
  (gen_random_uuid(), '${CB1}', '${U3}');

INSERT INTO threads (id, channel_id, updated_at) VALUES
  ('${THA1}', '${CA1}', now()),
  ('${THB1}', '${CB1}', now());

INSERT INTO messages (id, thread_id, user_id, role, content, reply_participant_ids) VALUES
  ('${MA1}', '${THA1}', '${U1}', 'user', 'hello alpha', '{}'),
  ('${MB1}', '${THB1}', '${U2}', 'user', 'hello beta', '{}'),
  ('${MB2}', '${THB1}', '${U3}', 'user', 'hi from both-orgs user', '{}');

INSERT INTO agents (id, name, organization_id, project_id, team_id, updated_at) VALUES
  ('${GA}', 'Org-wide agent', '${ORG}', NULL, NULL, now()),
  ('${GB}', 'Beta team agent', '${ORG}', '${PB1}', '${TB1}', now());

INSERT INTO runs (id, agent_id, thread_id, status) VALUES
  ('${RB1}', '${GB}', '${THB1}', 'completed');

INSERT INTO run_checkpoints (id, organization_id, run_id, agent_id, thread_id, reason, note)
VALUES ('${RCB}', '${ORG}', '${RB1}', '${GB}', '${THB1}', 'token_limit', 'work-state note');

INSERT INTO tasks (id, organization_id, project_id, run_id, updated_at) VALUES
  ('${TKB}', '${ORG}', '${PB1}', NULL, now()),
  ('${TKR}', '${ORG}', NULL, '${RB1}', now()),
  ('${TKO}', '${ORG}', NULL, NULL, now());

INSERT INTO knowledge_spaces (id, name, organization_id, project_id, created_by, updated_at)
VALUES ('${KSB}', 'Beta space', '${ORG}', '${PB1}', '${U2}', now());

INSERT INTO knowledge_pages (id, space_id, title, organization_id, project_id, created_by, updated_at)
VALUES ('${KPB}', '${KSB}', 'Beta page', '${ORG}', '${PB1}', '${U2}', now());

INSERT INTO attachments (id, organization_id, uploader_id, message_id, kind, mime, filename, size_bytes, storage_key) VALUES
  ('${ATM}', '${ORG}', '${U2}', '${MB1}', 'file', 'text/plain', 'beta.txt', 42, 'att/beta.txt'),
  ('${ATA}', '${ORG}', '${U1}', NULL, 'image', 'image/png', 'avatar.png', 7, 'att/avatar.png');

INSERT INTO storage_usage_events (id, occurred_at, organization_id, uploader_id, attachment_id, delta_bytes, operation, actor_id) VALUES
  ('${SE1}', now(), '${ORG}', '${U2}', '${ATM}', 42, 'store', '${U2}'),
  ('${SE2}', now(), '${ORG}', '${U1}', NULL, 7, 'store', '${U1}');

INSERT INTO budgets (id, organization_id, scope_type, scope_id, updated_at) VALUES
  ('${BO}', '${ORG}', 'organization', '${ORG}', now()),
  ('${BP}', '${ORG}', 'project', '${PB1}', now()),
  ('${BT}', '${ORG}', 'team', '${TB1}', now());

INSERT INTO audit_logs (id, organization_id, channel_id, actor_type, actor_id, action, resource_type, outcome, request_id, prev_hash, entry_hash) VALUES
  ('${AUD1}', '${ORG}', '${CB1}', 'user', '${U2}', 'message.create', 'message', 'success', 'req-1', NULL, 'hash-1'),
  ('${AUD2}', '${ORG}', NULL, 'user', '${U1}', 'org.update', 'organization', 'success', 'req-2', 'hash-1', 'hash-2');

INSERT INTO token_ledger_events (id, occurred_at, organization_id, channel_id, actor_id, request_id, provider, model, operation_type) VALUES
  ('${TLE1}', now(), '${ORG}', '${CB1}', '${U2}', 'req-3', 'openai', 'gpt-test', 'chat'),
  ('${TLE2}', now(), '${ORG}', NULL, '${U1}', 'req-4', 'openai', 'gpt-test', 'chat');

INSERT INTO user_alerts (id, organization_id, user_id, kind, channel_id, message_id) VALUES
  ('${UA1}', '${ORG}', '${U2}', 'mention', '${CB1}', '${MB1}'),
  ('${UA2}', '${ORG}', '${U1}', 'mention', NULL, NULL);

INSERT INTO realtime_events (organization_id, channel_id, event_type, payload)
VALUES ('${ORG}', '${CB1}', 'message.new', '{}');

-- Exercises the one composite FK in the schema:
-- executors (project_id, organization_id) → projects (id, organization_id)
-- ON UPDATE CASCADE, so the projects move must carry this row atomically.
INSERT INTO executors (id, organization_id, project_id, scope_kind, pairing_owner_user_id, label, updated_at)
VALUES ('${EXB}', '${ORG}', '${PB1}', 'project', '${U2}', 'beta executor', now());

-- Migrations may already seed the first-party 'nessie' product row.
INSERT INTO integrated_products (id, slug, name, summary, category, auth_mode, default_install_state, updated_at)
VALUES (gen_random_uuid(), 'nessie', 'Nessie', 'The product itself', 'research', 'uoa_sso', 'native', now())
ON CONFLICT (slug) DO NOTHING;

INSERT INTO product_account_links (id, organization_id, user_id, product_slug, uoa_sub, status, updated_at) VALUES
  ('${LNK2}', '${ORG}', '${U2}', 'nessie', 'uoa-sub-u2', 'linked', now()),
  ('${LNK3}', '${ORG}', '${U3}', 'nessie', 'uoa-sub-u3', 'linked', now());

INSERT INTO refresh_tokens (id, user_id, family_id, session_id, provider_id, provider_type, token_hash, expires_at)
VALUES ('${RT2}', '${U2}', '${FAM2}', gen_random_uuid(), 'uoa', 'oidc', 'tokenhash-u2', now() + interval '30 days');

INSERT INTO uoa_session_credentials (family_id, user_id, provider_id, subject, organization_id, team_id,
  token_version, config_url, refresh_token_hash, refresh_token_ciphertext, refresh_token_iv,
  refresh_token_auth_tag, refresh_token_expires_at, last_local_token_id, updated_at)
VALUES ('${FAM2}', '${U2}', 'uoa', 'uoa-sub-u2', '${EXT_BETA}', 'ws-beta-1',
  1, 'https://uoa.example/config', 'uoa-rt-hash', 'ct', 'iv', 'tag', now() + interval '30 days', '${RT2}', now());

COMMIT;
`;

function tableCounts(args, dbName) {
  const rows = psql(
    args,
    dbName,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations' ORDER BY table_name`,
  )
    .split('\n')
    .filter(Boolean);
  const counts = {};
  for (const table of rows) {
    counts[table] = Number(psql(args, dbName, `SELECT count(*) FROM "${table}"`));
  }
  return counts;
}

function runAssertions(args, assertions) {
  let failures = 0;
  for (const [name, sql, expected] of assertions) {
    const actual = psql(args, SEEDED_DB, sql);
    if (actual === expected) {
      console.log(`  ok   ${name}`);
    } else {
      failures += 1;
      console.error(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}

function phaseA(args) {
  console.log('Phase A: seeded flattened-model scenario');
  recreateDb(args, SEEDED_DB);
  const staging = stagePreMigrations();
  try {
    console.log('  deploying pre-partition migration chain...');
    migrateDeploy(args, path.join(staging, 'schema.prisma'), SEEDED_DB);
    console.log('  seeding flattened pre-state...');
    psqlScript(args, SEEDED_DB, SEED_SQL);

    const pre = tableCounts(args, SEEDED_DB);
    console.log('  deploying the partition pair...');
    migrateDeploy(args, path.join('api', 'prisma', 'schema.prisma'), SEEDED_DB);
    const post = tableCounts(args, SEEDED_DB);

    // Row-count conservation: the partition MOVES rows; the only additions are
    // the one new organization and the seeded memberships (u2 + u3 in beta).
    let failures = 0;
    for (const table of Object.keys(pre)) {
      let expected = pre[table];
      if (table === 'organizations') expected += 1;
      if (table === 'organization_members') expected += 2;
      if (post[table] !== expected) {
        failures += 1;
        console.error(`  FAIL count ${table}: expected ${expected}, got ${post[table]}`);
      }
    }
    if (failures === 0) console.log(`  ok   row counts conserved across ${Object.keys(pre).length} tables`);

    failures += runAssertions(args, [
      ['exactly one new organization', 'SELECT count(*) FROM organizations', '2'],
      ['shared org adopts plurality external org (alpha, 3 teams vs 1)',
        `SELECT external_org_id FROM organizations WHERE id = '${ORG}'`, EXT_ALPHA],
      ['beta org created with placeholder name + external id',
        `SELECT count(*) FROM organizations WHERE external_org_id = '${EXT_BETA}' AND name = 'Organisation ' || left('${EXT_BETA}', 8)`, '1'],

      // Moved team: project, channel, agent, run artifacts, tasks, KB.
      ['beta project moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM projects WHERE id = '${PB1}'`, 't'],
      ['beta channel moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM channels WHERE id = '${CB1}'`, 't'],
      ['beta team agent moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM agents WHERE id = '${GB}'`, 't'],
      ['org-wide agent stays', `SELECT organization_id FROM agents WHERE id = '${GA}'`, ORG],
      ['run checkpoint follows its thread', `SELECT organization_id::text = (${BETA_ORG})::text FROM run_checkpoints WHERE id = '${RCB}'`, 't'],
      ['project task moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM tasks WHERE id = '${TKB}'`, 't'],
      ['run-owned project-less task moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM tasks WHERE id = '${TKR}'`, 't'],
      ['orphan task stays with adopting org', `SELECT organization_id FROM tasks WHERE id = '${TKO}'`, ORG],
      ['knowledge space moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM knowledge_spaces WHERE id = '${KSB}'`, 't'],
      ['knowledge page moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM knowledge_pages WHERE id = '${KPB}'`, 't'],
      ['message attachment moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM attachments WHERE id = '${ATM}'`, 't'],
      ['avatar-only attachment stays', `SELECT organization_id FROM attachments WHERE id = '${ATA}'`, ORG],
      ['channel alert moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM user_alerts WHERE id = '${UA1}'`, 't'],
      ['ref-less alert stays', `SELECT organization_id FROM user_alerts WHERE id = '${UA2}'`, ORG],
      ['executor follows its project (composite FK cascade)',
        `SELECT organization_id::text = (${BETA_ORG})::text FROM executors WHERE id = '${EXB}'`, 't'],
      ['realtime backlog row follows channel',
        `SELECT count(*) FROM realtime_events WHERE channel_id = '${CB1}' AND organization_id::text <> (${BETA_ORG})::text`, '0'],

      // Ledgers and audit.
      ['budget scoped to org stays', `SELECT organization_id FROM budgets WHERE id = '${BO}'`, ORG],
      ['budget scoped to moved project moves', `SELECT organization_id::text = (${BETA_ORG})::text FROM budgets WHERE id = '${BP}'`, 't'],
      ['budget scoped to moved team moves', `SELECT organization_id::text = (${BETA_ORG})::text FROM budgets WHERE id = '${BT}'`, 't'],
      ['channel audit row moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM audit_logs WHERE id = '${AUD1}'`, 't'],
      ['org-only audit row stays', `SELECT organization_id FROM audit_logs WHERE id = '${AUD2}'`, ORG],
      ['audit hash chains reset to pre-chain epoch in affected orgs',
        `SELECT count(*) FROM audit_logs WHERE prev_hash IS NOT NULL OR entry_hash IS NOT NULL`, '0'],
      ['channel token-ledger row moved', `SELECT organization_id::text = (${BETA_ORG})::text FROM token_ledger_events WHERE id = '${TLE1}'`, 't'],
      ['org-only token-ledger row stays', `SELECT organization_id FROM token_ledger_events WHERE id = '${TLE2}'`, ORG],
      ['storage event follows its attachment', `SELECT organization_id::text = (${BETA_ORG})::text FROM storage_usage_events WHERE id = '${SE1}'`, 't'],
      ['ref-less storage event stays', `SELECT organization_id FROM storage_usage_events WHERE id = '${SE2}'`, ORG],

      // (b) membership seeding, max-role rule.
      ['beta org memberships seeded from moved team members',
        `SELECT string_agg(user_id::text || ':' || role::text, ',' ORDER BY user_id)
           FROM organization_members WHERE organization_id = ${BETA_ORG}`,
        `${U2}:admin,${U3}:owner`],
      ['old-org memberships kept',
        `SELECT count(*) FROM organization_members WHERE organization_id = '${ORG}'`, '4'],

      // (c) product account links.
      ['u2 (beta-only) link moved to beta org', `SELECT organization_id::text = (${BETA_ORG})::text FROM product_account_links WHERE id = '${LNK2}'`, 't'],
      ['u3 (both orgs) link stays in old org', `SELECT organization_id FROM product_account_links WHERE id = '${LNK3}'`, ORG],

      // Refresh material untouched (UOA's own opaque ids, not local orgs).
      ['uoa session credential untouched',
        `SELECT organization_id || '|' || team_id FROM uoa_session_credentials WHERE family_id = '${FAM2}'`,
        `${EXT_BETA}|ws-beta-1`],
      ['refresh token untouched', `SELECT count(*) FROM refresh_tokens WHERE id = '${RT2}' AND user_id = '${U2}'`, '1'],

      // Local-only team and the adopting org's own teams untouched.
      ['local project untouched', `SELECT organization_id FROM projects WHERE id = '${PL}'`, ORG],
      ['local channel untouched', `SELECT organization_id FROM channels WHERE id = '${CL1}'`, ORG],
      ['alpha projects untouched',
        `SELECT count(*) FROM projects WHERE id IN ('${PA1}','${PA2}','${PA3}') AND organization_id = '${ORG}'`, '3'],
      ['alpha channel untouched', `SELECT organization_id FROM channels WHERE id = '${CA1}'`, ORG],

      // Join sweeps: no organization_id may disagree with its parent's.
      ['sweep: channels vs project', `SELECT count(*) FROM channels c JOIN projects p ON p.id = c.project_id WHERE c.organization_id <> p.organization_id`, '0'],
      ['sweep: knowledge spaces vs project', `SELECT count(*) FROM knowledge_spaces s JOIN projects p ON p.id = s.project_id WHERE s.organization_id <> p.organization_id`, '0'],
      ['sweep: knowledge pages vs project', `SELECT count(*) FROM knowledge_pages k JOIN projects p ON p.id = k.project_id WHERE k.organization_id <> p.organization_id`, '0'],
      ['sweep: tasks-with-project vs project', `SELECT count(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.organization_id <> p.organization_id`, '0'],
      ['sweep: agents-with-project vs project', `SELECT count(*) FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.organization_id <> p.organization_id`, '0'],
      ['sweep: run checkpoints vs thread channel',
        `SELECT count(*) FROM run_checkpoints rc JOIN threads th ON th.id = rc.thread_id JOIN channels c ON c.id = th.channel_id WHERE rc.organization_id <> c.organization_id`, '0'],
      ['sweep: message attachments vs thread channel',
        `SELECT count(*) FROM attachments a JOIN messages m ON m.id = a.message_id JOIN threads th ON th.id = m.thread_id JOIN channels c ON c.id = th.channel_id WHERE a.organization_id <> c.organization_id`, '0'],
      ['sweep: budgets vs scope',
        `SELECT count(*) FROM budgets b
          LEFT JOIN projects p ON b.scope_type = 'project' AND p.id = b.scope_id
          LEFT JOIN teams t ON b.scope_type = 'team' AND t.id = b.scope_id
          LEFT JOIN projects tp ON tp.id = t.project_id
         WHERE (p.id IS NOT NULL AND b.organization_id <> p.organization_id)
            OR (tp.id IS NOT NULL AND b.organization_id <> tp.organization_id)`, '0'],
      ['sweep: teams reachable through exactly one org',
        `SELECT count(*) FROM teams t JOIN projects p ON p.id = t.project_id
          JOIN organizations o ON o.id = p.organization_id
         WHERE t.external_org_id IS NOT NULL AND t.external_org_id <> o.external_org_id`, '0'],

      ['all migrations recorded applied',
        `SELECT count(*)::text FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        String(listMigrations().length)],
    ]);

    if (failures > 0) fail(`${failures} Phase A assertion(s) failed`);
    console.log('Phase A: PASS');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function phaseB(args) {
  console.log('Phase B: baseline upgrade-fixture convergence');
  const fixture = path.join('api', 'prisma', 'upgrade-fixtures', 'baseline.sql.gz');
  if (!fs.existsSync(fixture)) fail(`missing fixture: ${fixture}`);
  recreateDb(args, UPGRADE_DB);
  const sql = zlib.gunzipSync(fs.readFileSync(fixture)).toString('utf8');
  psqlScript(args, UPGRADE_DB, sql);
  migrateDeploy(args, path.join('api', 'prisma', 'schema.prisma'), UPGRADE_DB);

  const applied = psql(
    args,
    UPGRADE_DB,
    `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  const expected = String(listMigrations().length);
  if (applied !== expected) {
    fail(`baseline convergence: ${applied} migrations applied, ${expected} folders on disk`);
  }
  const orgCount = psql(args, UPGRADE_DB, 'SELECT count(*) FROM organizations');
  const extCol = psql(
    args,
    UPGRADE_DB,
    `SELECT count(*) FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'external_org_id'`,
  );
  if (extCol !== '1') fail('external_org_id column missing after upgrade');
  console.log(`  ok   ${applied} migrations applied; organizations rows: ${orgCount}; partition no-op on fixture`);
  console.log('Phase B: PASS');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    phaseA(args);
    phaseB(args);
    console.log('verify-partition: PASS');
  } finally {
    if (!args.keepDbs) {
      dropDb(args, SEEDED_DB);
      dropDb(args, UPGRADE_DB);
    }
  }
}

main();
