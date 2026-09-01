import type { PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { isAgentAccessibleToActor } from './access-checks.js'
import { collectWorkflowStepReferences, parseWorkflowBindingTemplate } from './workflow-binding-grammar.js'
import { compileWorkflowJmespath } from './workflow-jmespath.js'

export type WorkflowStepForValidation = {
  id: string
  input?: Record<string, unknown>
  title?: string
  type: string
  when?: string
}

export type WorkflowGraphForValidation = { steps: WorkflowStepForValidation[] }

// This is the complete set of workflow step executors in the worker. It is
// shared by the human save path and the demonstration job so neither can save
// a graph that the execution engine would reject later.
export const WORKFLOW_EXECUTABLE_STEP_TYPES = new Set([
  'agent',
  'agent_task',
  'environment_launch',
  'message_send',
  'tool',
  'tool_call',
  'transform',
])

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const readStepInputString = (
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = input?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const collectStepBindingTemplates = (
  input: Record<string, unknown> | undefined,
): Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> => {
  const templates: Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> = []

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const template = parseWorkflowBindingTemplate(value)
      if (template.kind !== 'literal') templates.push({ key: path, template })
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
      if (key !== 'workflowDesigner') visit(entry, key)
    }
  }
  return templates
}

const collectStepJmespathStrings = (
  input: Record<string, unknown> | undefined,
): Array<{ key: string; value: string }> => {
  const found: Array<{ key: string; value: string }> = []

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.startsWith('jmespath:')) found.push({ key: path, value })
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
      if (key !== 'workflowDesigner') visit(entry, key)
    }
  }
  return found
}

/**
 * The one graph validator for human-authored and learned Workflow templates.
 * The caller owns how its issues are surfaced; keeping this as a list lets the
 * generalizer feed an invalid draft back to its bounded model loop.
 */
export const validateWorkflowGraph = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  graph: WorkflowGraphForValidation,
): Promise<string[]> => {
  const issues: string[] = []
  const seenStepIds = new Set<string>()
  const allStepIds = new Set(graph.steps.map((step) => step.id))
  const literalAgentIds = new Set<string>()

  for (const step of graph.steps) {
    const label = step.title?.trim() || step.id
    const priorStepIds = new Set(seenStepIds)
    for (const { key, template } of collectStepBindingTemplates(step.input)) {
      if (template.kind === 'invalid') {
        issues.push(`Step "${label}" has an invalid binding in "${key}": ${template.error}.`)
        continue
      }
      for (const token of collectWorkflowStepReferences(template)) {
        if (token.reference.kind !== 'steps') continue
        if (!priorStepIds.has(token.reference.stepId)) {
          issues.push(
            allStepIds.has(token.reference.stepId)
              ? `Step "${label}" references "${token.reference.stepId}" before it has run — steps can only bind earlier steps' output.`
              : `Step "${label}" references unknown step "${token.reference.stepId}" in "${key}".`,
          )
        }
      }
    }

    for (const { key, value } of collectStepJmespathStrings(step.input)) {
      const expressionError = compileWorkflowJmespath(value.slice('jmespath:'.length))
      if (expressionError) {
        issues.push(`Step "${label}" has an invalid jmespath expression in "${key}": ${expressionError}.`)
      }
    }
    if (typeof step.when === 'string' && step.when.trim()) {
      const whenError = compileWorkflowJmespath(step.when)
      if (whenError) issues.push(`Step "${label}" has an invalid when guard: ${whenError}.`)
    }

    if (seenStepIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" — step outputs would collide.`)
    }
    seenStepIds.add(step.id)

    if (!WORKFLOW_EXECUTABLE_STEP_TYPES.has(step.type)) {
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
      } else if (parseWorkflowBindingTemplate(toolName).kind !== 'exact' && !WORKFLOW_TOOL_IDS.has(toolName)) {
        issues.push(
          `Tool step "${label}" uses unknown tool "${toolName}". Available: ${[...WORKFLOW_TOOL_IDS].sort().join(', ')}.`,
        )
      }
    }

    if (step.type === 'agent' || step.type === 'agent_task') {
      const agentId = readStepInputString(step.input, 'agentId')
      if (!agentId) {
        issues.push(`Agent step "${label}" is missing agentId.`)
      } else if (parseWorkflowBindingTemplate(agentId).kind !== 'exact') {
        if (UUID_PATTERN.test(agentId)) literalAgentIds.add(agentId)
        else issues.push(`Agent step "${label}" has an invalid agentId "${agentId}".`)
      }
    }

    if (step.type === 'environment_launch') {
      const templateId = readStepInputString(step.input, 'templateId')
      const templateBindingKey = readStepInputString(step.input, 'templateBindingKey')
      if (!templateId && !templateBindingKey) {
        issues.push(`Environment step "${label}" needs templateId or templateBindingKey.`)
      }
    }

    if (step.type === 'transform') {
      const expression = readStepInputString(step.input, 'expression')
      if (!expression) {
        issues.push(`Transform step "${label}" is missing expression.`)
      } else {
        const expressionError = compileWorkflowJmespath(expression)
        if (expressionError) issues.push(`Transform step "${label}" has an invalid expression: ${expressionError}.`)
      }
    }

    if (step.type === 'message_send' && !readStepInputString(step.input, 'body')) {
      issues.push(`Message step "${label}" is missing body.`)
    }
  }

  for (const agentId of literalAgentIds) {
    if (!(await isAgentAccessibleToActor(prisma, actorContext, agentId))) {
      issues.push(`Agent ${agentId.slice(0, 8)} referenced by an agent step does not exist.`)
    }
  }
  return issues
}

export const workflowGeneralizationVocabulary = {
  stepTypes: [...WORKFLOW_EXECUTABLE_STEP_TYPES],
  toolIds: [...WORKFLOW_TOOL_IDS].sort(),
}
