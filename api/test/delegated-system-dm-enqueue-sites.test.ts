import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Every path that starts a run must have decided, deliberately, whether the
 * destination is a single-member delegated system DM.
 *
 * `enqueueOrchestrateDecide` is a real chokepoint: it resolves the destination
 * channel itself and stamps `effectiveUserId` there, so a new wake path from a
 * human turn is correct without its author knowing this rule exists. There is
 * no equivalent chokepoint for `enqueueRunExecution` — the payload carries a
 * thread, its callers construct actor contexts from six different provenances
 * (a person, a trigger's captured origin, a mailbox sender, a parent run), and
 * a blanket stamp there would be a guess about whose identity is in play. So
 * that half is enumerated instead: each call site is classified below, and a
 * new one fails this test until its author records a verdict.
 *
 * That is deliberately the weaker of the two mechanisms. It cannot make a new
 * site correct — only unignorable.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..')

/**
 * Why each `enqueueRunExecution` call site is correct.
 *
 * `stamps`      — applies `withDelegatedSystemDmIdentity`, or an equivalent
 *                 explicit `effectiveUserId` for the destination's one member.
 * `inherits`    — re-enqueues an actor context another site already stamped.
 * `unattended`  — enqueues `interactive: false` (or leaves it unset), so
 *                 `resolveDelegatedRequesterUserId` refuses regardless. A
 *                 trigger, a to-do, an auto-continuation and a delegate child
 *                 are automation, not a person present at the keyboard.
 */
const ENQUEUE_RUN_EXECUTION_SITES: Record<string, 'stamps' | 'inherits' | 'unattended'> = {
  'api/src/services/executor-run-launch.ts': 'stamps',
  'api/src/services/integration-handoffs.ts': 'stamps',
  'api/src/services/run-continuation.ts': 'stamps',
  'api/src/services/run-resume-core.ts': 'stamps',
  'api/src/services/runs.ts': 'stamps',
  'api/src/services/trigger-dispatch.ts': 'unattended',
  'packages/db/src/thread-serialization.ts': 'inherits',
  'packages/workspace-admin/src/agent-todo-run.ts': 'unattended',
  'packages/workspace-admin/src/global-agent-brief.ts': 'stamps',
  'worker/src/control/agent-email/inbound.ts': 'unattended',
  'worker/src/control/mailbox.ts': 'unattended',
  'worker/src/control/trigger-run.ts': 'unattended',
  'worker/src/run/execute/continuation.ts': 'unattended',
  'worker/src/run/orchestrate.ts': 'inherits',
  'worker/src/run/subtask-tools.ts': 'unattended',
}

const SEARCH_ROOTS = [
  'api/src',
  'worker/src',
  'packages/db/src',
  'packages/workspace-admin/src',
]

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * A call, not an import, a re-export, a `{ enqueueRunExecution }` handed to an
 * injected queue seam, or the `enqueueRunExecution: (…) =>` field that declares
 * one. The optional `)` catches the `(deps.enqueue ?? enqueueRunExecution)(…)`
 * form the integration handoff uses.
 */
const callsEnqueueRunExecution = (source: string): boolean =>
  /enqueueRunExecution\s*\)?\s*\(/.test(source)

test('every enqueueRunExecution call site has a recorded delegated-identity verdict', () => {
  const found: string[] = []
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const source = readFileSync(file, 'utf8')
      if (!callsEnqueueRunExecution(source)) continue
      found.push(relative(repoRoot, file).split('\\').join('/'))
    }
  }

  const declared = Object.keys(ENQUEUE_RUN_EXECUTION_SITES).sort()
  assert.deepEqual(
    found.sort(),
    declared,
    'A run-enqueue site was added or moved. Decide whether its destination can be a '
    + 'single-member delegated system DM: if it can and the turn is interactive, stamp '
    + '`effectiveUserId` with `withDelegatedSystemDmIdentity`; then record the verdict in '
    + 'ENQUEUE_RUN_EXECUTION_SITES. An unstamped run loses every identity-delegated tool '
    + 'silently — nothing throws, the agent just says it cannot do the thing.',
  )
})

test('the human-turn wake path has exactly one enqueue chokepoint', () => {
  const chokepoint = readFileSync(
    join(repoRoot, 'api/src/queue/pgqueue.ts'),
    'utf8',
  )
  assert.match(
    chokepoint,
    /withDelegatedSystemDmIdentity/,
    'enqueueOrchestrateDecide must stamp the destination\'s delegated identity itself; '
    + 'moving that decision back to its callers is how the agent-card press lost it.',
  )
  assert.match(
    chokepoint,
    /prisma\.channel\.findUnique/,
    'the chokepoint must resolve the destination channel itself — a caller-supplied '
    + '`systemChannelType` is exactly the argument a new wake path forgets to pass.',
  )
})
