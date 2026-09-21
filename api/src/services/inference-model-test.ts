import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  createModelClient,
  isLedgerEndpoint,
  ProviderHttpError,
  type LedgerIdentityService,
} from '@nessie/runtime'

import type { InferenceModelTestResult } from '../contracts/inference-model-catalog.js'
import { recordModelUsage } from './model-usage-recorder.js'

/**
 * Send one real prompt to one exact provider/model pair and report what came
 * back.
 *
 * **Why a client per test.** `sharedModelClient` is pinned to a single Ledger
 * service: `createInferenceService` rewrites the base URL to `/v1/<serviceId>`
 * once, at construction. Testing pair (P, M) therefore needs its own client
 * built around P, used, and closed. The call still goes through
 * `createModelClient`, so it inherits IP-pinned egress — a hand-rolled fetch to
 * a provider URL would bypass that and fails the root egress lint besides.
 *
 * **It is billed.** On a signing deployment attribution is mandatory, so the
 * call carries the owner's own provenance and lands in the token ledger exactly
 * like any other. The UI says so; the prompt and the output cap are both tiny
 * so the truthful answer to "what does this cost" is "almost nothing".
 *
 * **What it sends.** A plain "Hi" as the only message — what a person would
 * type — and the reply is shown verbatim. No system prompt: some providers
 * (Gemma on Google AI Studio, among others) refuse one outright, which made
 * the probe fail on models that chat perfectly well.
 *
 * **Why the output cap is not tiny.** Reasoning models (gpt-5, o-series,
 * DeepSeek R1, Gemma thinking) spend completion tokens thinking before they
 * write anything. A 64-token cap left them nothing to answer with, so a
 * healthy model came back as "returned no text". A greeting's answer is short
 * whatever the cap, so the cap only bounds the thinking.
 *
 * **One retry for a transient refusal.** A 429 or 5xx says "not now", not
 * "broken" — free OpenRouter models are throttled upstream constantly. One
 * retry after a short pause, inside the same overall deadline, turns most of
 * those into a real answer; a second refusal is reported as it came.
 */

export const TEST_PROMPT = 'Hi'
export const MAX_OUTPUT_TOKENS = 1024
const TEST_TIMEOUT_MS = 45_000
const RETRY_DELAY_MS = 2_000
const MAX_ATTEMPTS = 2

const isTransient = (error: unknown): boolean =>
  error instanceof ProviderHttpError
  && (error.statusCode === 429 || error.statusCode >= 500)

export type InferenceModelTestInput = {
  actorContext: AuthorizedActionContext
  config: ModelConfig
  ledgerIdentity: LedgerIdentityService | null
  logger: { warn: (bindings: unknown, message: string) => void }
  model: string
  prisma: PrismaClient
  provider: string
  /** Injected by tests; production always builds the real pinned client. */
  createClient?: typeof createModelClient
  sleep?: (ms: number) => Promise<void>
}

const RATE_LIMIT_NOTE =
  'The provider is rate-limiting this model right now; try again in a minute. '

const failureFrom = (
  error: unknown,
  connectorName: string,
  provider: string,
): { code: string; message: string } => {
  if (error instanceof Error) {
    // The provider's own words, verbatim. An owner distinguishes a rejected key
    // from a retired model from a timeout by reading them, and a message this
    // layer rewrote would take that away. Two things are corrected around
    // them: the leading label names the deployment's connector ("deepseek"),
    // not the provider under test, which read as the wrong model answering;
    // and a rate limit says in plain words that the model is not broken.
    const prefix = `${connectorName} `
    const message = error.message.startsWith(prefix)
      ? `${provider} ${error.message.slice(prefix.length)}`
      : error.message
    const rateLimited = error instanceof ProviderHttpError && error.statusCode === 429
    return {
      code: error.name || 'INFERENCE_MODEL_TEST_FAILED',
      message: rateLimited ? `${RATE_LIMIT_NOTE}${message}` : message,
    }
  }
  return {
    code: 'INFERENCE_MODEL_TEST_FAILED',
    message: 'The model did not answer, and the provider gave no reason.',
  }
}

export const runInferenceModelTest = async (
  input: InferenceModelTestInput,
): Promise<InferenceModelTestResult> => {
  const signer = isLedgerEndpoint(input.config.baseUrl) && input.ledgerIdentity
    ? input.ledgerIdentity
    : null
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Constructed inside the try: `resolveLedgerServiceBaseUrl` refuses a service
  // id that is not a single URL segment, and an owner who typed one is owed the
  // refusal as this route's structured failure rather than a 500.
  let client: ReturnType<typeof createModelClient> | null = null
  const build = input.createClient ?? createModelClient
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  try {
    client = build(
      { ...input.config, modelName: input.model, serviceId: input.provider },
      {
        recordUsage: (invocations, attribution) =>
          recordModelUsage(input.prisma, input.logger, invocations, attribution),
        ...(signer
          ? {
            requestHeaders: (
              attribution: Parameters<LedgerIdentityService['requestHeaders']>[0],
            ) => signer.requestHeaders(attribution, { requireUoaIdentity: true }),
          }
          : {}),
        systemComponent: 'inference-model-test',
      },
    )

    const activeClient = client
    const ask = async (): Promise<string> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await activeClient.chat(
            [{ content: TEST_PROMPT, role: 'user' }],
            {
              maxTokens: MAX_OUTPUT_TOKENS,
              model: input.model,
              usage: attributionFromActorContext(input.actorContext, {
                systemComponent: 'inference-model-test',
              }),
            },
          )
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS || !isTransient(error)) throw error
          await sleep(RETRY_DELAY_MS)
        }
      }
    }
    const reply = await Promise.race([
      ask(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The model did not answer within ${TEST_TIMEOUT_MS / 1000}s.`)),
          TEST_TIMEOUT_MS,
        )
      }),
    ])

    const latencyMs = Date.now() - startedAt
    const text = reply.trim()
    if (!text) {
      return {
        failure: {
          code: 'INFERENCE_MODEL_TEST_EMPTY_REPLY',
          message: 'The provider accepted the request but returned no text.',
        },
        latencyMs,
        model: input.model,
        ok: false,
        provider: input.provider,
      }
    }
    return { latencyMs, model: input.model, ok: true, provider: input.provider, reply: text }
  } catch (error) {
    return {
      failure: failureFrom(error, input.config.provider, input.provider),
      latencyMs: Date.now() - startedAt,
      model: input.model,
      ok: false,
      provider: input.provider,
    }
  } finally {
    // The losing half of the race keeps an event-loop handle alive otherwise,
    // which is how a route handler holds a process open past its own response.
    if (timer) clearTimeout(timer)
    client?.close()
  }
}
