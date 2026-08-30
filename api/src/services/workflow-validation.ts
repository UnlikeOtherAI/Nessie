import type { PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import {
  WORKFLOW_SECRET_WRITE_ERROR,
  collectWorkflowStepReferences,
  compileWorkflowJmespath,
  parseWorkflowBindingTemplate,
  validateWorkflowSecretWrite,
  type WorkflowBindingSecretError,
} from '@nessie/workspace-admin'

import type { WorkflowGraph } from '../contracts.js'

/**
 * Save-time validation of workflow graph steps against what the worker
 * runtime actually executes (`worker/src/control/workflows.ts`). Anything
 * rejected here would otherwise fail the run at execution time. `{{ … }}`
 * binding tokens are resolved at run time, so literal checks apply only when
 * the value is not an exact single-token binding — but every binding is
 * parsed (syntax must be valid) and every `steps.<id>` reference must name a
 * step that exists AND precedes the referencing step in execution order
 * (W9): a typo is a save error, not a failed run. `channelId` is never
 * required because the runtime falls back to the installation's channel.
 */
// W0: public writes never store caller-chosen refs or plaintext into a
// reference binding (mirrors the MCP credential-ref rule). Thrown by the
// install/update paths; routes map it to 400.
export class WorkflowSecretWriteError extends Error {
  readonly violations: WorkflowBindingSecretError[]

  constructor(violations: WorkflowBindingSecretError[]) {
    super(WORKFLOW_SECRET_WRITE_ERROR)
    this.violations = violations
  }
}

export class WorkflowTemplateValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super('WORKFLOW_TEMPLATE_INVALID')
    this.issues = issues
  }
}

// W13: `trigger` is not an executable step type. Trigger nodes on the canvas
// are authoring markers only; real scheduling is an `AgentTrigger` created
// from the installation's Triggers surface, and the runtime never sees one.
//
// W17's rule: this list accepts ONLY types with a registered executor branch
// in the worker (`executeWorkflowRun`'s runtimeStepType dispatch) — the rule
// that prevents another `delegate`-class bug, where validation passed a
// capability that could only fail mid-run. The designer mirrors this list
// (`admin/src/lib/workflow-designer/constants.ts` nodeThemes), and
// `admin/test/workflow-tool-allowlist.test.ts` fails on drift.
const WORKFLOW_STEP_TYPES = new Set([
  'agent',
  'agent_task',
  'environment_launch',
  // W15: a deterministic channel write. Also reachable as a tool step with
  // toolName `message_send` (W12's WORKFLOW_TOOL_IDS is the tool allow-list);
  // this is the explicit step-type form.
  'message_send',
  'tool',
  'tool_call',
  // W17: the deterministic converter (§5). Executor: the `transform` branch
  // of executeWorkflowRun → worker/src/control/workflow-transform.ts.
  'transform',
])

const collectStepBindingTemplates = (
  input: Record<string, unknown> | undefined,
): Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> => {
  const templates: Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> = []

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const template = parseWorkflowBindingTemplate(value)
      if (template.kind !== 'literal') {
        templates.push({ key: path, template })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, path ? `${path}.${key}` : key)
      }
    }
  }

  if (input) {
    for (const [key, entry] of Object.entries(input)) {
      if (key === 'workflowDesigner') {
        continue
      }
      visit(entry, key)
    }
  }

  return templates
}

// W17: every literal string in a step's input that carries the `jmespath:`
// prefix, with its key path for the validation issue. Bindings embedded in
// the tail are expanded at run time; the save-time compiler sees the raw
// expression (its parser tolerates `{{…}}` only where JMESPath grammar does —
// a binding-shaped tail that does not parse is a save error, matching W9's
// "typo is a save error" rule).
const collectStepJmespathStrings = (
  input: Record<string, unknown> | undefined,
): Array<{ key: string; value: string }> => {
  const found: Array<{ key: string; value: string }> = []

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.startsWith('jmespath:')) {
        found.push({ key: path, value })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, path ? `${path}.${key}` : key)
      }
    }
  }

  if (input) {
    for (const [key, entry] of Object.entries(input)) {
      if (key === 'workflowDesigner') {
        continue
      }
      visit(entry, key)
    }
  }

  return found
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const readStepInputString = (
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = input?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export const validateWorkflowGraphSteps = async (
  prisma: PrismaClient,
  organizationId: string,
  graph: WorkflowGraph,
): Promise<void> => {
  const issues: string[] = []
  const seenStepIds = new Set<string>()
  const allStepIds = new Set(graph.steps.map((step) => step.id))
  const literalAgentIds = new Set<string>()

  for (const step of graph.steps) {
    const label = step.title?.trim() || step.id

    // W9: binding syntax is validated on EVERY step, and every `steps.<id>`
    // reference must name a step that exists and precedes this one — a typo
    // is a save error here, not a WORKFLOW_BINDING_NOT_FOUND mid-run.
    const priorStepIds = new Set(seenStepIds)
    for (const { key, template } of collectStepBindingTemplates(step.input)) {
      if (template.kind === 'invalid') {
        issues.push(`Step "${label}" has an invalid binding in "${key}": ${template.error}.`)
        continue
      }
      for (const token of collectWorkflowStepReferences(template)) {
        const reference = token.reference
        if (reference.kind !== 'steps') {
          continue
        }
        if (!priorStepIds.has(reference.stepId)) {
          issues.push(
            allStepIds.has(reference.stepId)
              ? `Step "${label}" references "${reference.stepId}" before it has run — steps can only bind earlier steps' output.`
              : `Step "${label}" references unknown step "${reference.stepId}" in "${key}".`,
          )
        }
      }
    }

    // W17: compile every inline `jmespath:` string at save time, through the
    // same evaluator seam as the `when:` guard — a bad expression is a save
    // error, never a mid-run surprise. The prefix form is checked on the
    // literal string; `jmespath:` mixed with a binding token expands at run
    // time, but a literal prefix with a compile error is caught here.
    for (const { key, value } of collectStepJmespathStrings(step.input)) {
      const expression = value.slice('jmespath:'.length)
      // Bindings may still expand the tail; only the static prefix is
      // compile-checkable, so compile the whole post-prefix string — W9's
      // binding syntax check above already rejects an unparseable tail.
      const expressionError = compileWorkflowJmespath(expression)
      if (expressionError) {
        issues.push(`Step "${label}" has an invalid jmespath expression in "${key}": ${expressionError}.`)
      }
    }

    // W16: compile the `when:` guard at save time through the one evaluator
    // module — a bad predicate is a save error, never a mid-run surprise.
    if (typeof step.when === 'string' && step.when.trim()) {
      const whenError = compileWorkflowJmespath(step.when)
      if (whenError) {
        issues.push(`Step "${label}" has an invalid when guard: ${whenError}.`)
      }
    }

    if (seenStepIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" — step outputs would collide.`)
    }
    seenStepIds.add(step.id)

    if (!WORKFLOW_STEP_TYPES.has(step.type)) {
      issues.push(
        step.type === 'trigger'
          ? `Step "${label}" has type "trigger", which is not executable — scheduling is authored on the installation's Triggers page, not in the graph.`
          : `Step "${label}" has unsupported type "${step.type}". Supported: tool, agent, environment_launch, message_send, transform.`,
      )
      continue
    }

    if (step.type === 'tool' || step.type === 'tool_call') {
      const toolName = readStepInputString(step.input, 'toolName')
      if (!toolName) {
        issues.push(`Tool step "${label}" is missing toolName.`)
      } else {
        const template = parseWorkflowBindingTemplate(toolName)
        // An exact single-token binding resolves to whatever the referenced
        // value holds — only a literal or inline-interpolated name can be
        // checked against the allow-list at save time.
        if (template.kind !== 'exact' && !WORKFLOW_TOOL_IDS.has(toolName)) {
          issues.push(
            `Tool step "${label}" uses unknown tool "${toolName}". Available: ${[...WORKFLOW_TOOL_IDS].sort().join(', ')}.`,
          )
        }
      }
    }

    if (step.type === 'agent' || step.type === 'agent_task') {
      const agentId = readStepInputString(step.input, 'agentId')
      if (!agentId) {
        issues.push(`Agent step "${label}" is missing agentId.`)
      } else if (parseWorkflowBindingTemplate(agentId).kind !== 'exact') {
        if (UUID_PATTERN.test(agentId)) {
          literalAgentIds.add(agentId)
        } else {
          issues.push(`Agent step "${label}" has an invalid agentId "${agentId}".`)
        }
      }
    }

    if (step.type === 'environment_launch') {
      const templateId = readStepInputString(step.input, 'templateId')
      const templateBindingKey = readStepInputString(step.input, 'templateBindingKey')
      if (!templateId && !templateBindingKey) {
        issues.push(
          `Environment step "${label}" needs templateId or templateBindingKey.`,
        )
      }
    }

    if (step.type === 'transform') {
      // §5: `expression` is required and compiled; `source` is optional and
      // may be a binding (checked by the W9 pass above).
      const expression = readStepInputString(step.input, 'expression')
      if (!expression) {
        issues.push(`Transform step "${label}" is missing expression.`)
      }
      // Compilation of the expression is covered by the jmespath pass only
      // for the `jmespath:` prefix form; the transform step's expression
      // field is compiled explicitly here.
      if (expression) {
        const expressionError = compileWorkflowJmespath(expression)
        if (expressionError) {
          issues.push(`Transform step "${label}" has an invalid expression: ${expressionError}.`)
        }
      }
    }

    if (step.type === 'message_send') {
      const body = readStepInputString(step.input, 'body')
      // An exact single-token binding is checked at run time; everything else
      // (missing, empty literal) is a save error. channelId/threadId are
      // optional — the runtime falls back to the installation channel.
      if (!body) {
        issues.push(`Message step "${label}" is missing body.`)
      }
    }
  }

  if (literalAgentIds.size > 0) {
    const agents = await prisma.agent.findMany({
      where: {
        id: { in: [...literalAgentIds] },
        OR: [{ organizationId }, { organizationId: null }],
      },
      select: { id: true },
    })
    const foundIds = new Set(agents.map((agent) => agent.id))
    for (const agentId of literalAgentIds) {
      if (!foundIds.has(agentId)) {
        issues.push(`Agent ${agentId.slice(0, 8)} referenced by an agent step does not exist.`)
      }
    }
  }

  if (issues.length > 0) {
    throw new WorkflowTemplateValidationError(issues)
  }
}

// W0: the write gate. The install and update paths both validate caller
// JSON against the owning template's bindingSchema before persisting.
export const assertWorkflowSecretWrite = (input: {
  bindingSchema: unknown
  config?: Record<string, unknown>
  resolvedBindings?: Record<string, unknown>
}): void => {
  const violations = validateWorkflowSecretWrite(input)
  if (violations.length > 0) {
    throw new WorkflowSecretWriteError(violations)
  }
}

// Lives beside the other typed rejections rather than with the run services
// that raise it: template installation, run creation and the step-run actions
// all throw it, and keeping it at this leaf keeps those three modules from
// having to import each other.
export class WorkflowActionError extends Error {
  constructor(
    public code:
      | 'WORKFLOW_RUN_NOT_TERMINAL'
      | 'WORKFLOW_INSTALLATION_INACTIVE'
      | 'WORKFLOW_RUN_NOT_ACTIVE'
      | 'WORKFLOW_STEP_RUN_NOT_SKIPPABLE'
      | 'WORKFLOW_STEP_RUN_NOT_BLOCKABLE'
      | 'WORKFLOW_STEP_RUN_NOT_UNBLOCKABLE'
      | 'WORKFLOW_CONCURRENCY_INVALID'
      | 'WORKFLOW_RUN_OVERLAP_SKIPPED',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowActionError'
  }
}
