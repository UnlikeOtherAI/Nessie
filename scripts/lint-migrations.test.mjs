import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { deployCompatibilityViolation, incompatibleClauses, splitStatements } from './lint-migrations.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationsDir = join(repoRoot, 'api', 'prisma', 'migrations')
const manifestPath = join(repoRoot, 'api', 'prisma', 'deploy-incompatible-migrations.json')

const fixture = `
ALTER TABLE "dashboards" DROP COLUMN "home";
`

test('a migration with DROP COLUMN and no manifest entry is a violation', () => {
  const violation = deployCompatibilityViolation('20990101000000_drop_home', fixture, new Set())
  assert.ok(violation.includes('20990101000000_drop_home'))
  assert.ok(violation.includes('DROP COLUMN'))
  assert.ok(violation.includes('deploy-incompatible-migrations.json'))
})

test('the same migration passes once the manifest lists it', () => {
  const violation = deployCompatibilityViolation(
    '20990101000000_drop_home',
    fixture,
    new Set(['20990101000000_drop_home']),
  )
  assert.equal(violation, null)
})

test('DROP TABLE and SET NOT NULL are incompatible too', () => {
  const sql = `
DROP TABLE IF EXISTS "agent_categories";
ALTER TABLE "tasks" ALTER COLUMN "organization_id" SET NOT NULL;
`
  assert.deepEqual(incompatibleClauses(sql).sort(), ['DROP TABLE', 'SET NOT NULL'])
})

test('the words inside comments and string literals never trip the gate', () => {
  const sql = `
-- TODO: DROP COLUMN "legacy" once the backfill lands
/* the old shape did ALTER TABLE "t" SET NOT NULL by hand */
INSERT INTO "notes" ("body") VALUES ('reminder: DROP COLUMN is deferred; SET NOT NULL later');
INSERT INTO "notes" ("body") VALUES ('it''s not DROP TABLE either');
CREATE FUNCTION "f"() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'DROP TABLE "x"';
END;
$$ LANGUAGE plpgsql;
ALTER TABLE "notes" ADD COLUMN "body2" TEXT;
`
  assert.deepEqual(incompatibleClauses(sql), [])
})

test('splitting survives quoted semicolons and keeps quoted identifiers', () => {
  const statements = splitStatements(`
INSERT INTO "notes" ("body") VALUES ('a;b');
CREATE INDEX "notes_body_idx" ON "messages" ("body");
`)
  assert.equal(statements.length, 2)
  assert.ok(statements[1].includes('ON "messages"'))
})

// The whole-tree invariant main() enforces, checked here without git so the
// test runs anywhere: every genuinely incompatible migration in the tree is
// covered by the checked-in manifest.
test('every incompatible migration in the tree is manifest-listed', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const names = new Set(manifest.map((entry) => entry.migration))
  const uncovered = []
  for (const name of readdirSync(migrationsDir)) {
    const sqlPath = join(migrationsDir, name, 'migration.sql')
    if (!existsSync(sqlPath)) continue
    const violation = deployCompatibilityViolation(name, readFileSync(sqlPath, 'utf8'), names)
    if (violation) uncovered.push(violation)
  }
  assert.deepEqual(uncovered, [])
})

test('every manifest entry names a real migration and gives a reason', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.length > 0)
  for (const entry of manifest) {
    assert.match(entry.migration, /^\d+_/, `bad migration name in ${JSON.stringify(entry)}`)
    assert.ok(entry.reason?.length > 0, `missing reason for ${entry.migration}`)
    assert.ok(
      existsSync(join(migrationsDir, entry.migration, 'migration.sql')),
      `${entry.migration} has no migration directory; redeploy.sh would drain for it forever`,
    )
  }
})
