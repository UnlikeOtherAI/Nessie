/**
 * §5 agent authoring: `workflow_transform_preview` — the agent checks the
 * same JMESPath mapping a human does, against the same compiler and the
 * same security envelope (`@nessie/team-admin` workflow-jmespath.ts:
 * 4 KiB expression, 1 MiB input, 256 KiB output, off the event loop).
 * Deterministic by construction — no LLM in the loop, no I/O, no clock.
 */
import { evaluateWorkflowJmespath } from '@nessie/team-admin'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

export const runWorkflowTransformPreviewTool = async (
  _context: BuiltinToolRuntimeContext,
  expression: string,
  sampleJson: unknown,
): Promise<ToolExecutionResult> => {
  const source = expression.trim()
  if (!source) {
    throw new Error('expression is required.')
  }

  let sample: unknown = sampleJson
  if (typeof sampleJson === 'string') {
    try {
      sample = JSON.parse(sampleJson)
    } catch {
      throw new Error('sampleJson must be valid JSON.')
    }
  }

  const evaluated = await evaluateWorkflowJmespath(source, sample)
  return {
    inputSummary: source.slice(0, 120),
    outputPreview: evaluated.ok
      ? JSON.stringify(evaluated.value ?? null, null, 2)
      : `JMESPath error: ${evaluated.error}`,
    toolName: 'workflow_transform_preview',
  }
}
