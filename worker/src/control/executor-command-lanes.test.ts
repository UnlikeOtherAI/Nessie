import assert from 'node:assert/strict'
import test from 'node:test'

import type { QueueHandler } from '@nessie/runtime'

import {
  EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY,
  subscribeExecutorCommandLanes,
} from './executor-commands.js'
import { EXECUTOR_COMMAND_TOPIC } from '../run/executor-toolset.js'

// One subscription holds one job for its command's whole life, so a single
// lane let one machine's slow call hold up every other machine's command.
// The claim itself is `FOR UPDATE SKIP LOCKED`; concurrent claimers against a
// real queue are pinned in packages/runtime/test/queue-concurrent-claim.test.ts.
test('the worker holds four executor commands at once, each on its own claim loop', () => {
  const subscriptions: Array<{ handler: QueueHandler; options: unknown; topic: string }> = []
  const handler: QueueHandler = async () => undefined
  const controller = new AbortController()

  subscribeExecutorCommandLanes(
    (topic, laneHandler, options) => {
      subscriptions.push({ handler: laneHandler, options, topic })
    },
    handler,
    { signal: controller.signal },
  )

  assert.equal(EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY, 4)
  assert.equal(subscriptions.length, EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY)
  for (const subscription of subscriptions) {
    assert.equal(subscription.topic, EXECUTOR_COMMAND_TOPIC)
    assert.equal(subscription.handler, handler)
    // Every lane stops with the worker's drain, like any other subscription.
    assert.deepEqual(subscription.options, { signal: controller.signal })
  }
})
