// Save and restore the database the website's screenshots are taken of.
//
// `fixture.mjs` can rebuild it from nothing, but only against the schema it
// was written for: a year from now, a migration that renames a column will
// break the seed and the pictures cannot be re-taken at all. The dump is the
// other half of the answer — the exact rows, as they were when the current
// screenshots were made, restorable without re-deriving anything.
//
//   node e2e/marketing-shots/snapshot.mjs save     # write snapshot.sql
//   node e2e/marketing-shots/snapshot.mjs restore  # load it into DATABASE_URL
//
// To re-take the pictures from the saved rows rather than from a fresh seed:
//
//   prisma migrate deploy && snapshot.mjs restore && SHOTS_SKIP_SEED=1 … shots
//
// Data only. The schema comes from `prisma migrate deploy`, so restoring is
// always migrate-then-load and the dump never carries a stale copy of the
// schema. `--disable-triggers` is required: `agents` and `runs` have circular
// foreign keys, and a data-only load cannot satisfy both ends at once.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SNAPSHOT = resolve(HERE, 'snapshot.sql')

/**
 * Postgres client binaries are not on every developer's PATH — this repo's
 * own database usually runs in a container, and a `pg_dump` from a different
 * major version refuses to talk to it anyway. So: use the binaries inside the
 * container when one is named, and PATH otherwise.
 */
const command = (tool, url, extra) => {
  const container = process.env.SHOTS_PG_CONTAINER?.trim()
  const parsed = new URL(url)
  const database = parsed.pathname.replace(/^\//u, '')
  const user = decodeURIComponent(parsed.username)
  if (container) {
    return {
      args: ['exec', '-i', container, tool, '-U', user, '-d', database, ...extra],
      bin: 'docker',
    }
  }
  return { args: [url, ...extra], bin: tool }
}

const run = ({ args, bin }, { stdin, stdinText, stdout } = {}) => new Promise((done, fail) => {
  const pipeIn = stdin || stdinText !== undefined
  const child = spawn(bin, args, { stdio: [pipeIn ? 'pipe' : 'ignore', stdout ? 'pipe' : 'inherit', 'inherit'] })
  child.on('error', (error) => fail(new Error(`${bin} could not start (${error.message}) — put the Postgres client tools on PATH, or set SHOTS_PG_CONTAINER to the container running the database`)))
  if (stdin) createReadStream(stdin).pipe(child.stdin)
  else if (stdinText !== undefined) child.stdin.end(stdinText)
  if (stdout) child.stdout.pipe(createWriteStream(stdout))
  child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${bin} exited ${code}`))))
})

/**
 * Empty every table before loading.
 *
 * `prisma migrate deploy` does not leave an empty database — a data migration
 * writes the bootstrap organisation, project and team — so a plain load of a
 * data-only dump collides on `organizations_pkey`. Truncating first also makes
 * restoring twice in a row mean the same thing as restoring once.
 * `_prisma_migrations` is the one table that must survive: it is the record of
 * which schema this data belongs to.
 */
const TRUNCATE_ALL = `
DO $$
DECLARE statement text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' CASCADE'
    INTO statement
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
  IF statement IS NOT NULL THEN EXECUTE statement; END IF;
END $$;
`

const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required')
const action = process.argv[2]

if (action === 'save') {
  await run(
    command('pg_dump', url, [
      '--data-only',
      '--disable-triggers',
      '--no-owner',
      '--no-privileges',
      // Migration history belongs to the schema, which the dump does not carry.
      '--exclude-table=_prisma_migrations',
    ]),
    { stdout: SNAPSHOT },
  )
  console.log(`saved ${SNAPSHOT}`)
} else if (action === 'restore') {
  if (!existsSync(SNAPSHOT)) throw new Error(`${SNAPSHOT} is missing`)
  const psql = command('psql', url, ['--quiet', '--set', 'ON_ERROR_STOP=1'])
  await run(psql, { stdinText: TRUNCATE_ALL })
  await run(psql, { stdin: SNAPSHOT })
  console.log(`restored ${SNAPSHOT}`)
} else {
  throw new Error('usage: snapshot.mjs save|restore')
}
