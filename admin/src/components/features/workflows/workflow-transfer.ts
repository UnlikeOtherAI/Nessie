import type { WorkflowTemplateRecord } from '../../../lib/api-client'

/**
 * JSON export/import shape for workflow templates. Kept separate from the
 * API's `WorkflowTemplateRecord` so a template can round-trip through a file
 * without carrying identity/ownership fields (id, organizationId, etc.).
 */
export type WorkflowTemplateExport = {
  name: string
  description?: string | null
  graph: WorkflowTemplateRecord['graph']
  triggers: unknown
  version: number
}

export type WorkflowTemplateImportInput = {
  name: string
  description?: string
  graph: WorkflowTemplateRecord['graph']
  triggers?: unknown
}

const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workflow'
}

export const buildWorkflowExport = (
  template: WorkflowTemplateRecord,
): { fileName: string; json: string } => {
  const payload: WorkflowTemplateExport = {
    name: template.name,
    description: template.description ?? undefined,
    graph: template.graph,
    triggers: template.triggers,
    version: template.version,
  }

  return {
    fileName: `${slugify(template.name)}.workflow.json`,
    json: JSON.stringify(payload, null, 2),
  }
}

export const downloadWorkflowExport = (template: WorkflowTemplateRecord): void => {
  const { fileName, json } = buildWorkflowExport(template)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Defensively validates an imported workflow JSON payload. Never throws on
 * malformed input — returns a discriminated result instead so callers can
 * show an inline error rather than crash.
 */
export const parseWorkflowImport = (
  raw: string,
): { ok: true; value: WorkflowTemplateImportInput } | { ok: false; error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Expected a JSON object describing a workflow.' }
  }

  const name = parsed.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, error: 'Missing or empty "name" field.' }
  }

  const graph = parsed.graph
  if (!isPlainObject(graph)) {
    return { ok: false, error: 'Missing "graph" object.' }
  }

  const steps = graph.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: '"graph.steps" must be a non-empty array.' }
  }

  const hasInvalidStep = steps.some(
    (step) =>
      !isPlainObject(step) ||
      typeof step.id !== 'string' ||
      typeof step.type !== 'string',
  )
  if (hasInvalidStep) {
    return {
      ok: false,
      error: 'Every step needs a string "id" and "type".',
    }
  }

  const description = parsed.description
  const triggers = 'triggers' in parsed ? parsed.triggers : undefined

  return {
    ok: true,
    value: {
      name,
      description: typeof description === 'string' ? description : undefined,
      graph: graph as WorkflowTemplateRecord['graph'],
      triggers,
    },
  }
}
