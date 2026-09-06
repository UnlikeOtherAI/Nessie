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
  // Waking an agent because a person handed its browser back. The person is
  // not at the keyboard — they pressed Done and may have walked away — which
  // is exactly why the run is enqueued `interactive: false` rather than
  // claiming a live turn to reach the browser. The one capability it does need
  // travels as `browserHandback`, which grants that browser and nothing else.
  'api/src/services/browser-handover.ts': 'unattended',
  'api/src/services/executor-run-launch.ts': 'stamps',
  'api/src/services/integration-handoffs.ts': 'stamps',
  // The one continuation enqueue: the Continue press, the approval resume and
  // the card resume all reach the queue through it.
  'api/src/services/run-resume-core.ts': 'stamps',
  'api/src/services/runs.ts': 'stamps',
  'api/src/services/trigger-dispatch.ts': 'unattended',
  'packages/db/src/thread-serialization.ts': 'inherits',
  'packages/team-admin/src/agent-todo-run.ts': 'unattended',
  'packages/team-admin/src/global-agent-brief.ts': 'stamps',
  'worker/src/control/agent-email/inbound.ts': 'unattended',
  'worker/src/control/mailbox.ts': 'unattended',
  // The one run-start: a trigger fire and a board watcher's wake both reach
  // the queue through it. Both are automation — the kickoff is a `system`
  // message and nobody is at the keyboard — so `interactive` is never set and
  // `resolveDelegatedRequesterUserId` refuses either way.
  'worker/src/control/agent-run-start.ts': 'unattended',
  'worker/src/run/execute/continuation.ts': 'unattended',
  'worker/src/run/orchestrate.ts': 'inherits',
  'worker/src/run/subtask-tools.ts': 'unattended',
}

const SEARCH_ROOTS = [
  'api/src',
  'worker/src',
  'packages/db/src',
  'packages/team-admin/src',
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
  // The chokepoint lives in `@nessie/db`, beside the raw insert, because the
  // worker's own `send_message` tool wakes the same topic: an api-only module
  // is a rule the worker cannot reuse, and it reimplemented enqueue+stamping
  // with different logic for exactly as long as it was one.
  const chokepoint = readFileSync(
    join(repoRoot, 'packages/db/src/queue.ts'),
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

/**
 * The other half of the same promise: nobody may enqueue `orchestrate.decide`
 * around the chokepoint. A raw `enqueueQueueJob` with that topic is how the
 * worker's `send_message` tool ended up stamping the current run's acting user
 * unconditionally, where the chokepoint stamps the destination's implied
 * identity or nothing at all.
 */
test('no call site enqueues orchestrate.decide outside the chokepoint', () => {
  const offenders: string[] = []
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const relativePath = relative(repoRoot, file).split('\\').join('/')
      if (relativePath === 'packages/db/src/queue.ts') continue
      const source = readFileSync(file, 'utf8')
      if (/topic:\s*'orchestrate\.decide'/.test(source)) {
        offenders.push(relativePath)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Use `enqueueOrchestrateDecide` from `@nessie/db` instead of enqueuing the '
    + 'topic directly: it resolves the destination channel and stamps the '
    + 'delegated identity a single-member system DM implies.',
  )
})
