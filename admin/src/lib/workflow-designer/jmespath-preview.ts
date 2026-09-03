/**
 * §5 shape awareness, client side: the tree-path → JMESPath compiler behind
 * the field picker, and the live preview evaluator.
 *
 * The preview deliberately runs the SAME jmespath.js the worker's evaluator
 * runs (@nessie/team-admin workflow-jmespath.ts), in-process: a draft
 * expression the designer shows as green compiles and evaluates identically
 * at run time. The server-side envelope caps (4 KiB expression, 1 MiB
 * input, 256 KiB output) are mirrored here so the designer never previews
 * something the save-time compiler would reject.
 */
import { search as jmespathSearch } from 'jmespath'

export const WORKFLOW_JMESPATH_EXPRESSION_MAX_BYTES = 4 * 1024

export type WorkflowJmespathPreview =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'no-sample' }
  | { kind: 'value'; value: unknown }

/** Evaluate a draft expression against a persisted step sample. */
export const previewWorkflowJmespath = (
  expression: string,
  sample: unknown,
): WorkflowJmespathPreview => {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { kind: 'empty' }
  }
  if (new Blob([trimmed]).size > WORKFLOW_JMESPATH_EXPRESSION_MAX_BYTES) {
    return {
      kind: 'error',
      message: `Expression exceeds ${WORKFLOW_JMESPATH_EXPRESSION_MAX_BYTES} bytes — the save-time compiler rejects it too.`,
    }
  }
  if (sample === undefined) {
    return { kind: 'no-sample' }
  }
  try {
    const value = jmespathSearch(sample, trimmed)
    return { kind: 'value', value: value === undefined ? null : value }
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Invalid expression',
    }
  }
}

export type WorkflowSampleTreeNode = {
  /** Present on leaves and collapsible nodes alike — the expression for THIS node. */
  expression: string
  key: string
  children?: WorkflowSampleTreeNode[]
  preview: string
  value: unknown
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One tree path segment → JMESPath: bare identifier, quoted key, or index. */
const formatPathSegment = (segment: string | number, first: boolean): string => {
  if (typeof segment === 'number') {
    return `[${segment}]`
  }
  if (IDENTIFIER_PATTERN.test(segment)) {
    return first ? segment : `.${segment}`
  }
  const quoted = `"${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return first ? quoted : `.${quoted}`
}

export const treePathToJmespath = (path: Array<string | number>): string =>
  path.map((segment, index) => formatPathSegment(segment, index === 0)).join('')

const MAX_TREE_CHILDREN = 40
const MAX_TREE_DEPTH = 6

const previewOf = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'string') {
    return value.length > 48 ? `"${value.slice(0, 48)}…"` : JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`
  }
  return '{…}'
}

const buildTree = (
  value: unknown,
  key: string,
  path: Array<string | number>,
  depth: number,
): WorkflowSampleTreeNode => {
  const node: WorkflowSampleTreeNode = {
    expression: treePathToJmespath(path),
    key,
    preview: previewOf(value),
    value,
  }
  if (depth >= MAX_TREE_DEPTH) {
    return node
  }
  if (Array.isArray(value)) {
    node.children = value
      .slice(0, MAX_TREE_CHILDREN)
      .map((entry, index) => buildTree(entry, `[${index}]`, [...path, index], depth + 1))
    return node
  }
  if (value && typeof value === 'object') {
    node.children = Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_TREE_CHILDREN)
      .map(([childKey, entry]) => buildTree(entry, childKey, [...path, childKey], depth + 1))
  }
  return node
}

/** The expandable tree the inspector renders for one upstream step's sample. */
export const buildWorkflowSampleTree = (
  rootKey: string,
  sample: unknown,
): WorkflowSampleTreeNode => buildTree(sample, rootKey, [rootKey], 0)
