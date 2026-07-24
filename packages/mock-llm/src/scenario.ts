import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Scenario files are the shared, reusable description of a scripted mock-LLM
// conversation. One file = one multi-turn conversation; the same file drives
// in-process unit tests (createMockRunInference), full-pipeline smoke runs, and
// load runs (createMockLlmServer).

export const MockToolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1),
})
export type MockToolCall = z.infer<typeof MockToolCallSchema>

export const MockUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})
export type MockUsage = z.infer<typeof MockUsageSchema>

// Deterministic latency injection, applied before the turn's response is
// produced (and again between streamed chunks when `stream` is set).
export const MockLatencySchema = z.object({
  latencyMs: z.number().int().nonnegative().default(0),
})

// Streaming simulation: the response text is emitted in fixed-size chunks with
// an optional delay between chunks, mirroring a real provider's SSE cadence.
export const MockStreamSchema = z.object({
  chunkDelayMs: z.number().int().nonnegative().default(0),
  chunkSize: z.number().int().positive().default(16),
})
export type MockStream = z.infer<typeof MockStreamSchema>

// Failure injection: provider error shapes a real endpoint can produce —
// auth errors (401/403), rate limiting (429), and server errors (5xx).
export const MockErrorSchema = z.object({
  code: z.string().nullable().default(null),
  latencyMs: z.number().int().nonnegative().default(0),
  message: z.string().min(1),
  status: z.union([
    z.literal(400),
    z.literal(401),
    z.literal(403),
    z.literal(429),
    z.literal(500),
    z.literal(502),
    z.literal(503),
  ]),
  type: z.string().min(1).default('server_error'),
})
export type MockError = z.infer<typeof MockErrorSchema>

// Strict on both branches: without it an invalid error turn (e.g. an
// unsupported status) silently parses as a completion turn with defaults.
export const MockTurnSchema = z.union([
  z.object({
    error: MockErrorSchema,
  }).strict(),
  MockLatencySchema.extend({
    finishReason: z
      .enum(['stop', 'length', 'tool-call', 'content-filter', 'error', 'other'])
      .optional(),
    stream: MockStreamSchema.optional(),
    text: z.string().default(''),
    toolCalls: z.array(MockToolCallSchema).default([]),
    usage: MockUsageSchema.default({}),
  }).strict(),
])
export type MockTurn = z.infer<typeof MockTurnSchema>

export const MockScenarioSchema = z.object({
  defaults: z
    .object({
      latencyMs: z.number().int().nonnegative().default(0),
      model: z.string().min(1).default('mock-model'),
    })
    .default({ latencyMs: 0, model: 'mock-model' }),
  description: z.string().optional(),
  name: z.string().min(1),
  turns: z.array(MockTurnSchema).min(1),
})
export type MockScenario = z.infer<typeof MockScenarioSchema>

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Bundled scenario directory. From src/ (tsx) and dist/ (built) this resolves
// to the package root's scenarios/ folder in both cases.
export const scenariosDir = join(packageRoot, 'scenarios')

export const parseScenario = (raw: unknown): MockScenario =>
  MockScenarioSchema.parse(raw)

export const loadScenario = async (nameOrPath: string): Promise<MockScenario> => {
  const path = nameOrPath.endsWith('.json') || nameOrPath.includes('/')
    ? resolve(nameOrPath)
    : join(scenariosDir, `${nameOrPath}.json`)
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  try {
    return parseScenario(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid mock-LLM scenario at ${path}: ${detail}`)
  }
}

export const listScenarios = async (): Promise<string[]> =>
  (await readdir(scenariosDir))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort()
