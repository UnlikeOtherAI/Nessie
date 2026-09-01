/**
 * Workflow-facing names for the shared sandboxed JMESPath evaluator.
 *
 * The implementation moved to `sandboxed-jmespath.ts` when dashboards became
 * its second consumer — same evaluator, same caps, same worker-thread deadline,
 * just no longer named for one domain. These aliases keep every existing
 * workflow caller working unchanged.
 */

export {
  SANDBOXED_JMESPATH_EXPRESSION_MAX_BYTES as WORKFLOW_JMESPATH_EXPRESSION_MAX_BYTES,
  SANDBOXED_JMESPATH_INPUT_MAX_BYTES as WORKFLOW_JMESPATH_INPUT_MAX_BYTES,
  SANDBOXED_JMESPATH_OUTPUT_MAX_BYTES as WORKFLOW_JMESPATH_OUTPUT_MAX_BYTES,
  SANDBOXED_JMESPATH_EVAL_TIMEOUT_MS as WORKFLOW_JMESPATH_EVAL_TIMEOUT_MS,
  compileSandboxedJmespath as compileWorkflowJmespath,
  evaluateSandboxedJmespath as evaluateWorkflowJmespath,
  isSandboxedJmespathTruthy as isWorkflowJmespathTruthy,
  type SandboxedJmespathResult as WorkflowJmespathResult,
} from './sandboxed-jmespath.js'
