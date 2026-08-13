/**
 * A provider call deliberately aborted by Nessie — today, cooperative
 * cancellation of a run while a document is streaming.
 *
 * This is a distinct type rather than an inspected message because the error a
 * cancelled `fetch` throws is laundered on its way out: connectors wrap it and
 * `executeStage` re-wraps again, and `classifyError` reads only the outer
 * message. An abort that reached classification unrecognised would be read as
 * `transient` or `unknown`, and `callInferenceWithRetry` would then *re-run the
 * whole generation* the user just stopped — or surface an apology the loop
 * would deliver as a completed reply.
 *
 * `executeStage` therefore converts at the one place the signal is in scope:
 * if its signal is aborted, whatever the stack threw becomes this.
 */
export class InferenceAbortedError extends Error {
  readonly name = 'InferenceAbortedError'

  constructor(cause?: unknown) {
    super('Inference aborted', cause === undefined ? undefined : { cause })
  }
}

export const isInferenceAbortedError = (error: unknown): error is InferenceAbortedError =>
  error instanceof InferenceAbortedError
