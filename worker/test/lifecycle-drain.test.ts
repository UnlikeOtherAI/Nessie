import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { QueueSubscription } from '@nessie/runtime'
import {
  closeTransportsWithDeadline,
  DEFAULT_WORKER_DRAIN_TIMEOUT_MS,
  drainQueueSubscriptions,
  memoiseShutdown,
  resolveDrainTimeoutMs,
  startDeadQueueJobSweep,
  WORKER_DRAIN_TIMEOUT_REASON,
} from '../src/lifecycle.js'

type FakeSubscription = QueueSubscription & {
  readonly abandonedWith: string[]
  readonly stoppedBeforeSettling: () => boolean
}

// Stands in for a `PgQueueProvider` subscription: `done` resolves only once the
// in-flight handler settles, which is exactly what the drain has to wait for.
//
// `settleMs` is how long the handler keeps writing AFTER it has been abandoned.
// The real provider nacks first and lets the handler fall out afterwards, so
// `done` does not resolve just because `abandon()` returned; a drain that treats
// the nack as the end closes the pool on a handler mid-write.
const fakeSubscription = (
  options: { handlerMs: number | 'never'; settleMs?: number | 'never' },
): FakeSubscription => {
  const abandonedWith: string[] = []
  let stopped = false
  let stoppedBeforeSettling = false
  let inFlight = true
  let finish: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })

  if (options.handlerMs !== 'never') {
    void delay(options.handlerMs).then(() => {
      // A real loop would claim again here unless the drain had stopped it.
      stoppedBeforeSettling = stopped
      inFlight = false
      finish()
    })
  }

  return {
    // `PgQueueProvider` abandons nothing when it holds no job, so a
    // subscription that already drained records no reason.
    abandon: async (reason: string): Promise<void> => {
      if (!inFlight) {
        return
      }

      inFlight = false
      abandonedWith.push(reason)
      const settleMs = options.settleMs ?? 0
      if (settleMs === 'never') {
        return
      }
      if (settleMs === 0) {
        finish()
        return
      }
      void delay(settleMs).then(finish)
    },
    abandonedWith,
    stoppedBeforeSettling: () => stoppedBeforeSettling,
    done: settled,
    stop: (): void => {
      stopped = true
    },
  }
}

describe('drainQueueSubscriptions', () => {
  test('waits for an in-flight handler and never abandons it inside the deadline', async () => {
    const subscription = fakeSubscription({ handlerMs: 40 })

    const started = Date.now()
    const result = await drainQueueSubscriptions([subscription], { timeoutMs: 2_000 })

    assert.equal(result.timedOut, false)
    assert.deepEqual(subscription.abandonedWith, [])
    assert.equal(subscription.stoppedBeforeSettling(), true)
    // It really waited for the handler rather than returning on the spot.
    assert.ok(Date.now() - started >= 30, 'drain returned before the handler settled')
  })

  test('abandons the job when the handler outlives the deadline', async () => {
    const subscription = fakeSubscription({ handlerMs: 'never' })

    const started = Date.now()
    const result = await drainQueueSubscriptions([subscription], { timeoutMs: 120 })
    const elapsed = Date.now() - started

    assert.equal(result.timedOut, true)
    assert.deepEqual(subscription.abandonedWith, [WORKER_DRAIN_TIMEOUT_REASON])
    // Waited the full deadline before giving up, and no longer.
    assert.ok(elapsed >= 100, `drain gave up after ${elapsed}ms, before the deadline`)
    assert.ok(elapsed < 2_000, `drain took ${elapsed}ms, well past the deadline`)
  })

  test('drains every subscription, so one slow topic does not spare the rest', async () => {
    const quick = fakeSubscription({ handlerMs: 10 })
    const stuck = fakeSubscription({ handlerMs: 'never' })

    const result = await drainQueueSubscriptions([quick, stuck], { timeoutMs: 80 })

    assert.equal(result.timedOut, true)
    assert.deepEqual(quick.abandonedWith, [])
    assert.deepEqual(stuck.abandonedWith, [WORKER_DRAIN_TIMEOUT_REASON])
  })

  test('an empty subscription list drains immediately', async () => {
    assert.deepEqual(await drainQueueSubscriptions([], { timeoutMs: 10 }), {
      settleTimedOut: false,
      timedOut: false,
    })
  })

  test('waits for an abandoned handler to fall out before the caller tears down', async () => {
    // Abandoning nacks the row, which the queue is satisfied by; the handler is
    // still writing. `stop()` closes the pool and the Prisma client next, so the
    // drain owes it this window.
    const subscription = fakeSubscription({ handlerMs: 'never', settleMs: 200 })

    const started = Date.now()
    const result = await drainQueueSubscriptions([subscription], {
      settleMs: 2_000,
      timeoutMs: 60,
    })
    const elapsed = Date.now() - started

    assert.deepEqual(result, { settleTimedOut: false, timedOut: true })
    assert.deepEqual(subscription.abandonedWith, [WORKER_DRAIN_TIMEOUT_REASON])
    assert.ok(elapsed >= 240, `drain returned after ${elapsed}ms, before the handler settled`)
  })

  test('reports the handler that was still writing when the settle window closed', async () => {
    const subscription = fakeSubscription({ handlerMs: 'never', settleMs: 'never' })

    const started = Date.now()
    const result = await drainQueueSubscriptions([subscription], {
      settleMs: 120,
      timeoutMs: 60,
    })
    const elapsed = Date.now() - started

    // The one outcome the drain cannot prevent, so it is reported rather than
    // swallowed: the caller closes the pool under a handler that never fell out.
    assert.deepEqual(result, { settleTimedOut: true, timedOut: true })
    assert.ok(elapsed >= 150, `drain gave up after ${elapsed}ms, before the settle window closed`)
  })
})

describe('resolveDrainTimeoutMs', () => {
  test('defaults when unset, and rejects values that would collapse the deadline', () => {
    assert.equal(resolveDrainTimeoutMs({}), DEFAULT_WORKER_DRAIN_TIMEOUT_MS)
    assert.equal(
      resolveDrainTimeoutMs({ NESSIE_WORKER_DRAIN_TIMEOUT_MS: 'twenty' }),
      DEFAULT_WORKER_DRAIN_TIMEOUT_MS,
    )
    assert.equal(
      resolveDrainTimeoutMs({ NESSIE_WORKER_DRAIN_TIMEOUT_MS: '0' }),
      DEFAULT_WORKER_DRAIN_TIMEOUT_MS,
    )
    assert.equal(resolveDrainTimeoutMs({ NESSIE_WORKER_DRAIN_TIMEOUT_MS: '1500' }), 1_500)
  })
})

describe('startDeadQueueJobSweep', () => {
  test('never stacks a second pass on top of one still running', async () => {
    let started = 0
    let release: () => void = () => undefined
    const interval = startDeadQueueJobSweep(
      async () => {
        started += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      { intervalMs: 15 },
    )

    try {
      await delay(120)
      // Eight ticks fired; a sweep that never returned must still have run once.
      assert.equal(started, 1)
      release()
      await delay(40)
      assert.ok(started > 1, 'the sweep never resumed once the slow pass finished')
    } finally {
      clearInterval(interval)
      release()
    }
  })

  test('a failing pass is logged, not thrown, and the next tick still runs', async () => {
    let started = 0
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]): void => {
      errors.push(args[0])
    }
    const interval = startDeadQueueJobSweep(
      async () => {
        started += 1
        throw new Error('sweep exploded')
      },
      { intervalMs: 15 },
    )

    try {
      await delay(80)
      assert.ok(started >= 2, `the sweep stopped after ${started} pass(es)`)
      assert.ok(errors.includes('[worker.queue-dead-sweep] failed'))
    } finally {
      clearInterval(interval)
      console.error = originalError
    }
  })
})

describe('closeTransportsWithDeadline', () => {
  test('returns within its deadline even when a client is never released', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warnings.push(String(args[0]))
    }
    let prismaClosed = false

    try {
      const started = Date.now()
      const result = await closeTransportsWithDeadline(
        [
          { close: async () => undefined, label: 'realtime transport' },
          // `pool.end()` resolves only when every checked-out client is back. A
          // handler already written off at the settle window — parked on a row
          // lock its successor now holds — never returns its one, so an
          // unbounded await here is where SIGTERM used to stop until the
          // platform SIGKILLed the process.
          { close: () => new Promise<void>(() => undefined), label: 'postgres pool' },
          { close: async () => { prismaClosed = true }, label: 'prisma client' },
        ],
        { timeoutMs: 120 },
      )
      const elapsed = Date.now() - started

      assert.deepEqual(result, {
        timedOut: true,
        unfinished: ['postgres pool', 'prisma client'],
      })
      assert.equal(prismaClosed, false, 'the sequence ran past the transport that hung')
      assert.ok(elapsed >= 100, `teardown gave up after ${elapsed}ms, before its deadline`)
      // Without the deadline this never returns at all; the bound is the fix.
      assert.ok(elapsed < 5_000, `teardown took ${elapsed}ms — the deadline did not hold`)
      assert.ok(
        warnings.some((line) =>
          line.includes('hard deadline of 120ms ended the shutdown')
          && line.includes('postgres pool')),
        `the deadline was not logged plainly; saw ${JSON.stringify(warnings)}`,
      )
    } finally {
      console.warn = originalWarn
    }
  })

  test('a clean close reports no deadline and leaves nothing unfinished', async () => {
    const closed: string[] = []
    const result = await closeTransportsWithDeadline(
      [
        { close: async () => { closed.push('realtime transport') }, label: 'realtime transport' },
        { close: async () => { closed.push('postgres pool') }, label: 'postgres pool' },
        { close: async () => { closed.push('prisma client') }, label: 'prisma client' },
      ],
      { timeoutMs: 2_000 },
    )

    assert.deepEqual(result, { timedOut: false, unfinished: [] })
    // Ordered, not concurrent: the transports close in the order given.
    assert.deepEqual(closed, ['realtime transport', 'postgres pool', 'prisma client'])
  })

  test('a transport that rejects is logged and the ones after it still close', async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]): void => {
      errors.push(String(args[0]))
    }
    let prismaClosed = false

    try {
      const result = await closeTransportsWithDeadline(
        [
          {
            close: async () => {
              throw new Error('Called end on pool more than once')
            },
            label: 'postgres pool',
          },
          { close: async () => { prismaClosed = true }, label: 'prisma client' },
        ],
        { timeoutMs: 2_000 },
      )

      assert.deepEqual(result, { timedOut: false, unfinished: [] })
      assert.equal(prismaClosed, true, 'one failing close abandoned the rest of the teardown')
      assert.ok(errors.includes('[worker.teardown] postgres pool failed to close'))
    } finally {
      console.error = originalError
    }
  })
})

describe('memoiseShutdown', () => {
  test('a second signal joins the first shutdown rather than starting another', async () => {
    let drains = 0
    let ends = 0
    const raw = async (): Promise<void> => {
      drains += 1
      await delay(60)
      ends += 1
      if (ends > 1) {
        // pg's own message when a pool is ended twice. Unmemoised this rejects
        // inside a floating promise, and the unhandled rejection ends the
        // process before its teardown finishes.
        throw new Error('Called end on pool more than once')
      }
    }
    const stop = memoiseShutdown(raw)

    // The orchestrator's SIGTERM, then an operator's Ctrl-C partway through it.
    const first = stop()
    await delay(20)
    const second = stop()
    await Promise.all([first, second])

    assert.equal(drains, 1, 'the second signal started a second drain')
    assert.equal(ends, 1, 'the pool was closed twice')
    assert.equal(first, second, 'the second signal did not join the first shutdown')
  })

  test('a caller arriving after the shutdown finished gets the finished one', async () => {
    let runs = 0
    const stop = memoiseShutdown(async () => {
      runs += 1
    })

    await stop()
    await stop()

    assert.equal(runs, 1, 'a late signal replayed a shutdown that had already finished')
  })
})
