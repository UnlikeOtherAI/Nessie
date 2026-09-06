import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { QueueSubscription } from '@nessie/runtime'
import {
  DEFAULT_WORKER_DRAIN_TIMEOUT_MS,
  drainQueueSubscriptions,
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
const fakeSubscription = (options: { handlerMs: number | 'never' }): FakeSubscription => {
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
      finish()
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
    assert.deepEqual(await drainQueueSubscriptions([], { timeoutMs: 10 }), { timedOut: false })
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
