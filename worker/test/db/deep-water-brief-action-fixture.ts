import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  beginDeepWaterPersonAction,
  type DeepWaterBriefRun,
  type LedgerAttribution,
} from '@nessie/runtime'
import { LedgerScopeResultSchema, type DeepWaterBriefActionJobPayload } from '@nessie/schemas'

import { runDeepWaterBriefAction } from '../../src/control/deepwater-brief-action.js'
import type { DeepWaterWatchDeps } from '../../src/control/deepwater-watch.js'
import { researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The watch fixture, plus what a person's brief-action suite needs: the signed
 * attribution of every Ledger call, a brief already open in Ledger, and a way
 * to record a person's action the way the API does and run its job.
 */

export type ActionFixture = WatchFixture & {
  deps: DeepWaterWatchDeps
  attributions: LedgerAttribution[]
  /** A person's brief Ledger has opened, with its first planner turn answered. */
  openBrief: () => Promise<{ run: DeepWaterBriefRun; rs: string }>
  /** Record an action as the API does; returns the job the worker receives. */
  begin: (
    run: DeepWaterBriefRun,
    action: DeepWaterBriefActionJobPayload['action'],
    actor?: DeepWaterBriefActionJobPayload['actor'],
  ) => Promise<DeepWaterBriefActionJobPayload>
  /** The opening action a person's brief was inserted with. */
  opening: (run: DeepWaterBriefRun) => DeepWaterBriefActionJobPayload
  perform: (payload: DeepWaterBriefActionJobPayload) => Promise<void>
}

export const withActionFixture = (name: string, body: (fixture: ActionFixture) => Promise<void>): void => {
  runDatabaseTest(name, async (t) => {
    const probe = new PrismaClient()
    await assertGlobalQueuesQuiet(probe)
    await probe.$disconnect()
    const watch = await seedWatchFixture()
    t.after(() => watch.cleanup())
    const attributions: LedgerAttribution[] = []
    const signer = watch.deps.ledgerIdentity
    if (!signer) throw new Error('the watch fixture signs every call')
    const deps: DeepWaterWatchDeps = {
      ...watch.deps,
      ledgerIdentity: {
        requestHeaders: async (attribution, options) => {
          attributions.push(attribution)
          return signer.requestHeaders(attribution, options)
        },
      },
    }
    const requester = (): DeepWaterBriefActionJobPayload['actor'] => ({
      userId: watch.ids.requester,
      role: 'requester',
      identity: watch.identity,
    })
    const fixture: ActionFixture = {
      ...watch,
      deps,
      attributions,
      openBrief: async () => {
        const run = await watch.insert('person')
        const rs = researchId()
        await watch.attach(run.id, LedgerScopeResultSchema.parse(wireScope({
          id: rs,
          revision: 1,
          withTranscript: true,
          turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'person' },
        })))
        return { run: await watch.read(run.id), rs }
      },
      begin: async (run, action, actor = requester()) => {
        const job: DeepWaterBriefActionJobPayload = {
          organizationId: run.organizationId,
          runId: run.id,
          actionId: randomUUID(),
          actor,
          action,
        }
        const started = await watch.prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, { job }))
        if (started.kind !== 'started') throw new Error(`the action was not started (${started.kind})`)
        return job
      },
      opening: (run) => {
        const action = run.scopeState?.pendingAction
        if (!action) throw new Error('a person brief is inserted with its opening action')
        return {
          organizationId: run.organizationId,
          runId: run.id,
          actionId: action.actionId,
          actor: requester(),
          action: { kind: 'scope_start' },
        }
      },
      perform: (payload) =>
        runDeepWaterBriefAction(deps, payload, { attempt: 1, enqueuedAt: new Date().toISOString() }),
    }
    await body(fixture)
  })
}
