/**
 * The single sandboxed JMESPath evaluator, shared by every domain that needs to
 * run an author-supplied expression over an untrusted document.
 *
 * Consumers: workflow `when:` predicates and `transform` steps
 * (workflows-first-class plan §5), and dashboard data-source transforms
 * (2026-08-13-live-data-dashboards plan §4.2). It was originally
 * workflow-owned and named for it; dashboards became the second domain, so it
 * moved to a neutral name rather than being forked. `workflow-jmespath.ts`
 * keeps the original export names for existing callers.
 *
 * The grammar and its security envelope are defined exactly once:
 *
 * - expression cap 4 KiB (compile AND evaluate time);
 * - input document cap 1 MiB (serialized);
 * - output cap 256 KiB (serialized);
 * - evaluation runs in a `worker_thread` terminated on a deadline, so a
 *   pathological projection cannot block the worker's event loop — the 1 MiB
 *   input cap is the structural fuse (JMESPath has no loops or recursion), the
 *   thread is the real pre-emption (a timer on the evaluating thread cannot
 *   fire while evaluation holds it).
 *
 * Deterministic by construction: no I/O, no clock, no randomness, and the
 * caller is responsible for handing it an already-redacted document (W0).
 */

import { search as jmespathSearch } from 'jmespath'
import { Worker } from 'node:worker_threads'

// @types/jmespath declares only `search`; compile is the library's own parse
// step, used here purely as a syntax check. Parse errors surface from
// `search` at evaluate time as well, so a false negative here is impossible.
const jmespathCompile = (expression: string): void => {
  jmespathSearch({}, expression)
}

export const SANDBOXED_JMESPATH_EXPRESSION_MAX_BYTES = 4 * 1024
export const SANDBOXED_JMESPATH_INPUT_MAX_BYTES = 1024 * 1024
export const SANDBOXED_JMESPATH_OUTPUT_MAX_BYTES = 256 * 1024

// A thread spawn is tens of milliseconds; the deadline covers spawn +
// evaluation. Anything still running past it is terminated, not awaited.
export const SANDBOXED_JMESPATH_EVAL_TIMEOUT_MS = 1_000

export type SandboxedJmespathResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const expressionSizeError = (expression: string): string | null =>
  byteLength(expression) > SANDBOXED_JMESPATH_EXPRESSION_MAX_BYTES
    ? `expression exceeds ${SANDBOXED_JMESPATH_EXPRESSION_MAX_BYTES} bytes`
    : null

/**
 * Compile-time check, used by save-time validation: caps plus a parse. A bad
 * predicate is a save error, so the message is written for a template author.
 */
export const compileSandboxedJmespath = (expression: string): string | null => {
  if (!expression.trim()) {
    return 'empty expression'
  }
  const sizeError = expressionSizeError(expression)
  if (sizeError) {
    return sizeError
  }
  try {
    jmespathCompile(expression)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid expression'
  }
}

const serializeCapped = (value: unknown, capBytes: number): string | null => {
  let serialized: string
  try {
    serialized = JSON.stringify(value ?? null)
  } catch {
    return null
  }
  return byteLength(serialized) <= capBytes ? serialized : null
}

const EVAL_WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const jmespath = require('jmespath')
  try {
    const value = jmespath.search(workerData.document, workerData.expression)
    parentPort.postMessage({ ok: true, value: value === undefined ? null : value })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'evaluation failed',
    })
  }
`

const evaluateInWorker = (
  expression: string,
  serializedDocument: string,
  timeoutMs: number,
): Promise<SandboxedJmespathResult> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (result: SandboxedJmespathResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const worker = new Worker(EVAL_WORKER_SOURCE, {
      eval: true,
      workerData: {
        document: JSON.parse(serializedDocument) as unknown,
        expression,
      },
    })
    const deadline = setTimeout(() => {
      void worker.terminate()
      finish({ ok: false, error: `evaluation exceeded ${timeoutMs}ms and was terminated` })
    }, timeoutMs)
    deadline.unref()
    worker.unref()

    worker.once('message', (message: { ok: boolean; value?: unknown; error?: string }) => {
      clearTimeout(deadline)
      void worker.terminate()
      finish(
        message.ok
          ? { ok: true, value: message.value }
          : { ok: false, error: message.error ?? 'evaluation failed' },
      )
    })
    worker.once('error', (error) => {
      clearTimeout(deadline)
      finish({ ok: false, error: error.message })
    })
    worker.once('exit', (code) => {
      clearTimeout(deadline)
      if (code !== 0) {
        finish({ ok: false, error: `evaluation worker exited with code ${code}` })
      }
    })
  })

/**
 * Evaluate `expression` against `document` under the full §5 envelope. The
 * caller passes the already-redacted document; this function never sees the
 * redaction boundary itself.
 */
export const evaluateSandboxedJmespath = async (
  expression: string,
  document: unknown,
  options: { timeoutMs?: number } = {},
): Promise<SandboxedJmespathResult> => {
  if (!expression.trim()) {
    return { ok: false, error: 'empty expression' }
  }
  const sizeError = expressionSizeError(expression)
  if (sizeError) {
    return { ok: false, error: sizeError }
  }

  const serializedDocument = serializeCapped(document, SANDBOXED_JMESPATH_INPUT_MAX_BYTES)
  if (serializedDocument === null) {
    return {
      ok: false,
      error: `input document exceeds ${SANDBOXED_JMESPATH_INPUT_MAX_BYTES} bytes`,
    }
  }

  const evaluated = await evaluateInWorker(
    expression,
    serializedDocument,
    options.timeoutMs ?? SANDBOXED_JMESPATH_EVAL_TIMEOUT_MS,
  )
  if (!evaluated.ok) {
    return evaluated
  }

  const serializedOutput = serializeCapped(evaluated.value, SANDBOXED_JMESPATH_OUTPUT_MAX_BYTES)
  if (serializedOutput === null) {
    return {
      ok: false,
      error: `result exceeds ${SANDBOXED_JMESPATH_OUTPUT_MAX_BYTES} bytes`,
    }
  }
  return { ok: true, value: JSON.parse(serializedOutput) as unknown }
}

/**
 * The `when:` truthiness rule: JMESPath's own — `null`, `false`, `''`, `[]`
 * and `{}` are falsy, everything else truthy (jmespath.js does not implement
 * empty-object falsiness, so it is applied here to match the spec).
 */
export const isSandboxedJmespathTruthy = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false || value === '') {
    return false
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0
  }
  return true
}
