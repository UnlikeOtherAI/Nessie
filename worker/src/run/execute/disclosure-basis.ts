import { z } from 'zod'

/**
 * A scoped source a run consumed. Most scope types are `ThoughtAudienceType`
 * literals; `agent` names the people who can see that agent. Memories,
 * knowledge-base spaces, and transcript turns therefore still express their
 * provenance in one set-containment vocabulary.
 */
export type BasisScope = {
  scopeType: string
  scopeId: string
}

/** The durable representation used by message, run, and peer-mailbox basis rows. */
export const BasisScopeSchema = z.object({
  scopeId: z.string().min(1),
  scopeType: z.string().min(1),
})

/** A private conversation's channel scope and the human whose words were read. */
export type PrivateConversationSource = {
  /** Absent means a legacy or otherwise untraceable private source: deny export. */
  sourceAuthorUserId: string | null
  sourceChannelId: string
}

/** Durable private-conversation lineage for a delegated trigger or mailbox. */
export const PrivateConversationSourceSchema = z.object({
  sourceAuthorUserId: z.string().min(1).nullable(),
  sourceChannelId: z.string().min(1),
})
/**
 * Per-run accumulator of scoped sources the run actually consumed.
 *
 * A sink rather than a return value because sources arrive at different moments:
 * memories at setup, knowledge-base pages mid-loop from tool handlers, and
 * transcript turns as the conversation window is admitted. It lives on the run
 * context, so it is naturally serialised with the run — the tool dispatcher is
 * shared across runs and cannot hold this.
 *
 * Additive only. Nothing removes a source once consumed, which is what makes a
 * checkpoint's basis (and a compaction note's, since compaction only folds turns
 * the sink has already seen) correct without per-turn provenance.
 */
export type ConsumedSourceSink = {
  add: (scope: BasisScope) => void
  addAll: (scopes: readonly BasisScope[]) => void
  /** Every source consumed so far, de-duplicated. Order is insertion order. */
  list: () => BasisScope[]
  size: () => number
  /** Human authors whose private conversation material entered this run. */
  privateConversationSources: () => PrivateConversationSource[]
  /** Records one human turn from a non-public conversation. */
  addPrivateConversationSource: (source: PrivateConversationSource) => void
  /**
   * Records a local program's output under the scope of the conversation
   * local apps were launched in (`executor-host-output.ts`). The scope enters
   * the sink like any other; it is also kept apart as host output, because a
   * project write treats a public channel of its project as implied for that
   * stamp alone — the same scope from a recalled memory is not.
   */
  addHostOutputScope: (scope: BasisScope) => void
  /** The launch-conversation scopes host program output stamped, de-duplicated. */
  hostOutputScopes: () => BasisScope[]
}

const scopeKey = (scope: BasisScope): string => `${scope.scopeType}:${scope.scopeId}`

export const createConsumedSourceSink = (): ConsumedSourceSink => {
  const seen = new Map<string, BasisScope>()
  const privateConversationSources = new Map<string, PrivateConversationSource>()
  const hostOutput = new Map<string, BasisScope>()

  const add = (scope: BasisScope): void => {
    if (!scope.scopeType || !scope.scopeId) {
      return
    }
    const key = scopeKey(scope)
    if (!seen.has(key)) {
      seen.set(key, { scopeId: scope.scopeId, scopeType: scope.scopeType })
    }
  }

  return {
    add,
    addAll: (scopes) => {
      for (const scope of scopes) {
        add(scope)
      }
    },
    list: () => [...seen.values()],
    size: () => seen.size,
    privateConversationSources: () => [...privateConversationSources.values()],
    addPrivateConversationSource: (source) => {
      if (!source.sourceChannelId) return
      add({ scopeId: source.sourceChannelId, scopeType: 'channel' })
      const key = `${source.sourceChannelId}:${source.sourceAuthorUserId ?? 'unknown'}`
      if (!privateConversationSources.has(key)) {
        privateConversationSources.set(key, source)
      }
    },
    addHostOutputScope: (scope) => {
      if (!scope.scopeType || !scope.scopeId) return
      add(scope)
      const key = scopeKey(scope)
      if (!hostOutput.has(key)) hostOutput.set(key, { scopeId: scope.scopeId, scopeType: scope.scopeType })
    },
    hostOutputScopes: () => [...hostOutput.values()],
  }
}

/**
 * The pure reply-basis computation lives in `@nessie/runtime` so the API (the
 * DeepWater research-run viewer predicate) and the worker derive "what this
 * destination already implies" from one implementation.
 */
export {
  computeReplyBasis,
  EMAIL_SCOPE_TYPE,
  emailMailboxScope,
  subtractImpliedScopes,
} from '@nessie/runtime'
