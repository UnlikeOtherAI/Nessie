import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { providerHttpError } from './inference/connectors/connector-invocations.js'
import { completeLedgerAttribution } from './ledger-attribution.js'
import { isLedgerEndpoint, resolveLedgerServiceBaseUrl } from './ledger-identity.js'
import type { LedgerAttribution } from './ledger.js'
import type { ModelUsageSink } from './model.js'
import { pinnedFetch, type SafeFetchOptions } from './url-safety.js'

export type DecisionQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export type DecisionAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
}

/** A decision model evaluates a finite vocabulary; it cannot generate prose. */
export interface DecisionModelClient {
  evaluate(input: {
    state: Record<string, unknown>
    questions: Record<string, DecisionQuestion>
    usage: LedgerAttribution
    /**
     * How long the caller will wait. A caller whose own answer never depends on
     * the classifier (a one-on-one reply falls back to answering) waits less
     * than one whose configured work does.
     */
    timeoutMs?: number
  }): Promise<Record<string, DecisionAnswer>>
}

export class DecisionInputLimitError extends Error {
  constructor(
    public readonly reason: 'choice_options' | 'question_bytes' | 'request_bytes',
    public readonly questionId?: string,
  ) {
    super(reason === 'choice_options'
      ? 'A channel decision has more than 255 choices.'
      : 'The channel decision policy and conversation exceed the evaluation input limit.')
    this.name = 'DecisionInputLimitError'
  }
}

// UTF-8 JSON bytes conservatively bound text tokens, with room for provider
// framing below Jev's 32k state-plus-question and 64k aggregate token limits.
const MAX_QUESTION_BYTES = 24_000
const MAX_REQUEST_BYTES = 48_000
const MAX_CHOICE_OPTIONS = 255
const DEFAULT_EVALUATION_TIMEOUT_MS = 10_000

/** The Ledger service that routes Jev's evaluation protocol. */
export const JEV_LEDGER_SERVICE = 'vercel'

const serializeDecisionRequest = (
  model: string,
  state: Record<string, unknown>,
  questions: Record<string, DecisionQuestion>,
): string => {
  for (const [id, question] of Object.entries(questions)) {
    if (Object.keys(question.criteria).length > MAX_CHOICE_OPTIONS) {
      throw new DecisionInputLimitError('choice_options', id)
    }
    const single = JSON.stringify({ model, state, questions: { [id]: question } })
    if (Buffer.byteLength(single, 'utf8') > MAX_QUESTION_BYTES) {
      throw new DecisionInputLimitError('question_bytes', id)
    }
  }
  const body = JSON.stringify({ model, state, questions })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new DecisionInputLimitError('request_bytes')
  }
  return body
}

const ProbabilitySchema = z.number().finite().min(0).max(1)
const ResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(ProbabilitySchema),
  })),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
})

/** Uses the deployment's Ledger credential and identity, never a provider key. */
export const createLedgerDecisionClient = (options: {
  baseUrl: string
  apiKey: string
  transport?: SafeFetchOptions
  requestHeaders?: (attribution: LedgerAttribution) => Promise<Record<string, string>>
  recordUsage?: ModelUsageSink
}): DecisionModelClient => {
  if (!isLedgerEndpoint(options.baseUrl)) {
    throw new Error('Channel decisions require a Ledger inference endpoint.')
  }
  // Ledger serves Jev from its unified `vercel` connector (`/v1/vercel/evaluate`).
  // The separate `vercel-evaluate` service this once called was never enabled in
  // production and has been removed from Ledger.
  const baseUrl = resolveLedgerServiceBaseUrl(options.baseUrl, JEV_LEDGER_SERVICE)!
  return {
    async evaluate(input) {
      const model = 'typesafe-ai/jev'
      const body = serializeDecisionRequest(model, input.state, input.questions)
      const attribution = completeLedgerAttribution(input.usage, 'channel-decisions')
      const signedHeaders = await options.requestHeaders?.(attribution)
      const startedAt = Date.now()
      const requestId = randomUUID()
      const response = await pinnedFetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          ...signedHeaders,
        },
        body,
        signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS),
      }, options.transport)
      if (!response.ok) {
        throw await providerHttpError({
          ledgerRouted: true, operation: 'evaluate', provider: JEV_LEDGER_SERVICE, response,
        })
      }
      const result = ResponseSchema.parse(await response.json())
      // Operational metering follows the existing shared model client's best-effort sink.
      await options.recordUsage?.([{
        invocationId: randomUUID(), requestId, provider: JEV_LEDGER_SERVICE,
        model: result.model ?? model, operationType: 'other',
        usage: result.usage, latencyMs: Date.now() - startedAt,
      }], attribution).catch(() => undefined)
      for (const [id, question] of Object.entries(input.questions)) {
        const answer = result.answers[id]
        const options = Object.keys(question.criteria)
        if (!answer || !Object.hasOwn(question.criteria, answer.choice)
          || options.some((key) => !Object.hasOwn(answer.probabilities, key))
          || Object.keys(answer.probabilities).some((key) => !Object.hasOwn(question.criteria, key))) {
          throw new Error('Decision model returned an answer outside the requested options.')
        }
        const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0)
        if (Math.abs(total - 1) > 0.02) {
          throw new Error('Decision model returned an invalid probability distribution.')
        }
      }
      return result.answers
    },
  }
}
