/**
 * W17 (workflows-first-class plan §5): the deterministic `transform` step —
 * reshape one step's output into another step's input with no LLM in the
 * loop. A sibling module rather than a case in the executor's type switch
 * (the 500-line cap).
 *
 * The evaluator itself is the one §5 seam
 * (`@nessie/workspace-admin` `workflow-jmespath.ts`) shared with the `when:`
 * guard: 4 KiB expression, 1 MiB input, 256 KiB output, evaluated off the
 * event loop. This module only decides what the step's evaluation document
 * is and how the result is persisted.
 *
 * W0 sink 3: the full-context document is built from values that already
 * passed the redaction boundary, and the redacted result is what lands in
 * the persisted step `input`/`output` — a tainted binding cannot reach an
 * expression or survive into the run's artifacts.
 */
import {
  evaluateWorkflowJmespath,
  redactWorkflowSecretValues,
} from '@nessie/workspace-admin'

export const WORKFLOW_TRANSFORM_JMESPATH_PREFIX = 'jmespath:'

/**
 * The full binding context a `transform` expression sees when no explicit
 * `source` narrows it. Same shape as the `when:` guard document, plus the
 * step's own resolved input under `input` (with `expression`/`source`
 * themselves elided so the document is data, not authoring metadata).
 */
export const buildWorkflowTransformDocument = (input: {
  stepInput: Record<string, unknown>
  stepSnapshots: Record<string, { input: unknown; output: unknown; status: string }>
  taintedRefs: ReadonlySet<string>
  workflowBindings: unknown
  workflowConfig: unknown
  workflowInput: unknown
}): Record<string, unknown> => {
  const stepInput = Object.fromEntries(
    Object.entries(input.stepInput).filter(
      ([key]) => key !== 'expression' && key !== 'source' && key !== 'workflowDesigner',
    ),
  )
  return {
    input: stepInput,
    steps: Object.fromEntries(
      Object.entries(input.stepSnapshots).map(([stepId, snapshot]) => [
        stepId,
        { input: snapshot.input, output: snapshot.output, status: snapshot.status },
      ]),
    ),
    workflow: {
      bindings: input.workflowBindings,
      config: input.workflowConfig,
      input: input.workflowInput,
    },
  }
}

/**
 * The one `jmespath:` branch shared by the inline input form and the
 * transform step's own expression handling: `redact → evaluate → redact`.
 * The second pass is not redundant with the first — redaction is
 * value-shaped, so an expression that *constructed* a `secret_*`-shaped
 * string from untainted parts is caught here.
 */
export const evaluateWorkflowJmespathAtSink = async (
  expression: string,
  document: unknown,
  taintedRefs: ReadonlySet<string>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
  const evaluated = await evaluateWorkflowJmespath(
    expression,
    redactWorkflowSecretValues(document, taintedRefs),
  )
  if (!evaluated.ok) {
    return { ok: false, error: evaluated.error }
  }
  return {
    ok: true,
    value: redactWorkflowSecretValues(evaluated.value, taintedRefs),
  }
}

export type WorkflowTransformStepResult =
  | {
      ok: true
      /** Persisted as the step's `output.result`, wrapped like tool outputs. */
      value: unknown
    }
  | { ok: false; error: string }

/**
 * Execute the transform step's already-resolved input. `source` (optional)
 * narrows the evaluation document; absent, the expression runs against the
 * full binding context so one expression can join across steps.
 */
export const executeWorkflowTransformStep = async (input: {
  expression: string
  source: unknown
  sourceProvided: boolean
  stepInput: Record<string, unknown>
  stepSnapshots: Record<string, { input: unknown; output: unknown; status: string }>
  taintedRefs: ReadonlySet<string>
  workflowBindings: unknown
  workflowConfig: unknown
  workflowInput: unknown
}): Promise<WorkflowTransformStepResult> => {
  const document = input.sourceProvided
    ? input.source
    : buildWorkflowTransformDocument({
        stepInput: input.stepInput,
        stepSnapshots: input.stepSnapshots,
        taintedRefs: input.taintedRefs,
        workflowBindings: input.workflowBindings,
        workflowConfig: input.workflowConfig,
        workflowInput: input.workflowInput,
      })
  const evaluated = await evaluateWorkflowJmespathAtSink(
    input.expression,
    document,
    input.taintedRefs,
  )
  if (!evaluated.ok) {
    return { ok: false, error: evaluated.error }
  }
  return { ok: true, value: evaluated.value }
}
