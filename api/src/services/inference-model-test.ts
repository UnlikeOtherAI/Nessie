import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  createModelClient,
  isLedgerEndpoint,
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
 */

const TEST_PROMPT = 'Reply with one short sentence confirming you are reachable.'
const TEST_SYSTEM_PROMPT = 'You are a reachability probe. Answer in one short sentence.'
const MAX_OUTPUT_TOKENS = 64
const TEST_TIMEOUT_MS = 30_000

export type InferenceModelTestInput = {
  actorContext: AuthorizedActionContext
  config: ModelConfig
  ledgerIdentity: LedgerIdentityService | null
  logger: { warn: (bindings: unknown, message: string) => void }
  model: string
  prisma: PrismaClient
  provider: string
}

const failureFrom = (error: unknown): { code: string; message: string } => {
  if (error instanceof Error) {
    // The provider's own words, verbatim. An owner distinguishes a rejected key
    // from a retired model from a timeout by reading them, and a message this
    // layer rewrote would take that away.
    return { code: error.name || 'INFERENCE_MODEL_TEST_FAILED', message: error.message }
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
  try {
    client = createModelClient(
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

    const reply = await Promise.race([
      client.chat(
        [
          { content: TEST_SYSTEM_PROMPT, role: 'system' },
          { content: TEST_PROMPT, role: 'user' },
        ],
        {
          maxTokens: MAX_OUTPUT_TOKENS,
          model: input.model,
          usage: attributionFromActorContext(input.actorContext, {
            systemComponent: 'inference-model-test',
          }),
        },
      ),
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
      failure: failureFrom(error),
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
