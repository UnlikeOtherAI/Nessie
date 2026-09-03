/**
 * The single grammar for `{{ … }}` workflow binding expressions (§5 of the
 * workflows-first-class plan). Save-time validation in the API and runtime
 * resolution in the worker both consume this module — and the Stage-2
 * JMESPath compiler must too — so the syntax is defined exactly once here.
 *
 * Grammar:
 *   template   := text* (expression text*)*
 *   expression := "{{" ws* reference ws* "}}"
 *   reference  := segment ("." segment)*
 *   segment    := [A-Za-z0-9_-]+
 *   ws         := space | tab
 *
 * A reference is rooted at `workflow` (run input / installation config /
 * resolved bindings) or `steps` (a previous step's input/output/status).
 */

export type WorkflowBindingRoot = 'steps' | 'workflow'

export type WorkflowBindingScope =
  | { kind: 'steps'; path: string[]; scope: 'input' | 'output' | 'status'; stepId: string }
  | { kind: 'workflow'; path: string[]; scope: 'bindings' | 'config' | 'input' }

export type WorkflowBindingToken = {
  /** The full matched source, including braces — used for replacement. */
  raw: string
  reference: WorkflowBindingScope
  segments: string[]
}

export type WorkflowBindingTemplate =
  | { kind: 'invalid'; error: string }
  | { kind: 'mixed'; tokens: WorkflowBindingToken[] }
  | { kind: 'exact'; token: WorkflowBindingToken }
  | { kind: 'literal' }

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

export const parseWorkflowBindingExpression = (
  expression: string,
):
  | { ok: true; segments: string[]; root: WorkflowBindingRoot }
  | { ok: false; error: string } => {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { ok: false, error: 'empty expression' }
  }

  const segments = trimmed.split('.')
  if (segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
    return {
      ok: false,
      error: `invalid segment in "${trimmed}" (segments must match [A-Za-z0-9_-]+)`,
    }
  }

  const root = segments[0]
  if (root !== 'workflow' && root !== 'steps') {
    return {
      ok: false,
      error: `unknown root "${root}" — expressions start with "workflow" or "steps"`,
    }
  }

  if (segments.length < 2) {
    return { ok: false, error: `"${root}" alone is not a reference` }
  }

  return { ok: true, root, segments }
}

export const toWorkflowBindingScope = (
  root: WorkflowBindingRoot,
  segments: string[],
): WorkflowBindingScope | { error: string } => {
  if (root === 'steps') {
    const stepId = segments[1]!
    const scopeSegment = segments[2]
    if (scopeSegment !== 'input' && scopeSegment !== 'output' && scopeSegment !== 'status') {
      return {
        error: `steps.${stepId} must be followed by input, output, or status`,
      }
    }
    return {
      kind: 'steps',
      path: segments.slice(3),
      scope: scopeSegment,
      stepId,
    }
  }

  const scopeSegment = segments[1]
  if (scopeSegment === 'run') {
    if (segments[2] !== 'input' || segments.length < 4) {
      return { error: 'workflow.run.input must be followed by a path segment' }
    }
    return { kind: 'workflow', path: segments.slice(3), scope: 'input' }
  }
  if (scopeSegment === 'input' || scopeSegment === 'config' || scopeSegment === 'bindings') {
    return { kind: 'workflow', path: segments.slice(2), scope: scopeSegment }
  }
  return {
    error: `workflow must be followed by input, config, bindings, or run.input`,
  }
}

/**
 * Parse every `{{ … }}` token in a string. Braces never nest: an unmatched
 * `{{` or `}}` is a syntax error, not silent literal text.
 */
export const parseWorkflowBindingTemplate = (
  value: string,
): WorkflowBindingTemplate => {
  const tokens: WorkflowBindingToken[] = []
  let cursor = 0
  let covered = ''

  while (cursor < value.length) {
    const openIndex = value.indexOf('{{', cursor)
    const closeBeforeOpen = value.indexOf('}}', cursor)
    if (closeBeforeOpen !== -1 && (openIndex === -1 || closeBeforeOpen < openIndex)) {
      return { kind: 'invalid', error: 'unmatched "}}" — binding braces must pair' }
    }
    if (openIndex === -1) {
      break
    }

    const closeIndex = value.indexOf('}}', openIndex + 2)
    if (closeIndex === -1) {
      return { kind: 'invalid', error: 'unmatched "{{" — binding braces must pair' }
    }

    const inner = value.slice(openIndex + 2, closeIndex)
    const parsed = parseWorkflowBindingExpression(inner)
    if (!parsed.ok) {
      return { kind: 'invalid', error: `{{${inner}}}: ${parsed.error}` }
    }

    const scoped = toWorkflowBindingScope(parsed.root, parsed.segments)
    if ('error' in scoped) {
      return { kind: 'invalid', error: `{{${inner}}}: ${scoped.error}` }
    }

    const raw = value.slice(openIndex, closeIndex + 2)
    tokens.push({ raw, reference: scoped, segments: parsed.segments })
    covered += value.slice(cursor, openIndex) + raw
    cursor = closeIndex + 2
  }

  if (tokens.length === 0) {
    return { kind: 'literal' }
  }

  // An "exact" token is the whole string: its resolved value passes through
  // unstringified at runtime, so it may legally resolve to a non-string.
  covered += value.slice(cursor)
  if (tokens.length === 1 && covered.trim() === tokens[0]!.raw) {
    return { kind: 'exact', token: tokens[0]! }
  }

  return { kind: 'mixed', tokens }
}

/** Every `steps.<id>` reference in a string, in order of appearance. */
export const collectWorkflowStepReferences = (
  template: WorkflowBindingTemplate,
): WorkflowBindingToken[] => {
  if (template.kind === 'exact') {
    return template.token.reference.kind === 'steps' ? [template.token] : []
  }
  if (template.kind === 'mixed') {
    return template.tokens.filter((token) => token.reference.kind === 'steps')
  }
  return []
}
