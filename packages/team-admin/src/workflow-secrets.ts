/**
 * W0 — the workflow secret-taint boundary (plan §3.0).
 *
 * `WorkflowInstallation.resolvedBindings` and `.config` are arbitrary JSON
 * interpolated into step inputs, persisted on `WorkflowStepRun.input`, and
 * rendered in the run inspector. This module is the minimal boundary, shared
 * by the API (write validation + server-side response redaction) and the
 * worker (interpolation-time redaction so the channel, transform, prompt and
 * persisted-sample sinks never see a secret):
 *
 * - `bindingSchema` declares, per binding key, whether the value is a
 *   **literal** or a **reference**. Reference values must be server-minted
 *   `secret_*` refs — the only shape produced by the encrypted store in
 *   `@nessie/mcp-manage` (`createPgSecretStore` enforces the prefix).
 * - Writes are validated server-side: a caller can never store plaintext into
 *   a reference binding, and a `secret_*` ref can never land in a literal
 *   binding or in `config` (mirrors the MCP rule that public writes never
 *   accept a caller-chosen credential ref — docs/external-tool-integration.md
 *   §2). The write path supplies the secret material out-of-band and the
 *   service mints the ref.
 * - Reads and every downstream sink get a redacted projection: tainted values
 *   become {@link WORKFLOW_SECRET_REDACTION}, applied server-side — a
 *   client-side mask is not a boundary.
 */

export const WORKFLOW_SECRET_REDACTION = '[redacted]'

export const WORKFLOW_SECRET_REF_PATTERN = /^secret_[A-Za-z0-9_-]+$/

export const WORKFLOW_SECRET_WRITE_ERROR = 'WORKFLOW_BINDING_SECRET_INVALID'

export type WorkflowBindingSecretError = {
  code: typeof WORKFLOW_SECRET_WRITE_ERROR
  path: string
  reason: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Per-binding kind declared by `bindingSchema`. An entry is a reference when
 * it says so in any of the shapes authors write: `{ kind: 'reference' }`,
 * `{ type: 'reference' }`, `{ reference: true }`, or the bare string
 * `'reference'`.
 */
export const isWorkflowReferenceBindingEntry = (entry: unknown): boolean => {
  if (entry === 'reference') {
    return true
  }
  if (!isPlainObject(entry)) {
    return false
  }
  return (
    entry['kind'] === 'reference' ||
    entry['type'] === 'reference' ||
    entry['reference'] === true
  )
}

export const collectWorkflowReferenceBindingKeys = (
  bindingSchema: unknown,
): Set<string> => {
  const keys = new Set<string>()
  if (!isPlainObject(bindingSchema)) {
    return keys
  }
  for (const [key, entry] of Object.entries(bindingSchema)) {
    if (isWorkflowReferenceBindingEntry(entry)) {
      keys.add(key)
    }
  }
  return keys
}

export const isWorkflowSecretRef = (value: unknown): value is string =>
  typeof value === 'string' && WORKFLOW_SECRET_REF_PATTERN.test(value)

/**
 * Collect every `secret_*` ref reachable anywhere inside an arbitrary JSON
 * value, with paths for diagnostics. A ref nested in `config` or in a
 * literal-typed binding is caller-supplied material and rejected on write.
 */
export const collectSecretRefsInValue = (
  value: unknown,
  path = '',
): Array<{ path: string; ref: string }> => {
  if (isWorkflowSecretRef(value)) {
    return [{ path, ref: value }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectSecretRefsInValue(entry, `${path}[${index}]`),
    )
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectSecretRefsInValue(entry, path ? `${path}.${key}` : key),
    )
  }
  return []
}

/**
 * Server-side write gate for `resolvedBindings` + `config`. Returns the list
 * of violations (empty when the write is acceptable):
 *
 * - reference binding value must be exactly one server-minted `secret_*` ref
 *   string — anything else is plaintext;
 * - a `secret_*` ref anywhere else (literal bindings, `config`, nested) is a
 *   caller-chosen credential ref and refused.
 */
export const validateWorkflowSecretWrite = (input: {
  bindingSchema: unknown
  config?: Record<string, unknown>
  resolvedBindings?: Record<string, unknown>
}): WorkflowBindingSecretError[] => {
  const referenceKeys = collectWorkflowReferenceBindingKeys(input.bindingSchema)
  const errors: WorkflowBindingSecretError[] = []

  if (input.resolvedBindings) {
    for (const [key, value] of Object.entries(input.resolvedBindings)) {
      if (referenceKeys.has(key)) {
        if (!isWorkflowSecretRef(value)) {
          errors.push({
            code: WORKFLOW_SECRET_WRITE_ERROR,
            path: `resolvedBindings.${key}`,
            reason:
              'reference bindings hold only server-minted secret_* refs; submit the secret material, never the value',
          })
        }
        continue
      }
      for (const hit of collectSecretRefsInValue(value)) {
        errors.push({
          code: WORKFLOW_SECRET_WRITE_ERROR,
          path: `resolvedBindings.${key}${hit.path}`,
          reason: `literal bindings never store caller-chosen refs (${hit.ref})`,
        })
      }
    }
  }

  if (input.config) {
    for (const hit of collectSecretRefsInValue(input.config)) {
      errors.push({
        code: WORKFLOW_SECRET_WRITE_ERROR,
        path: `config${hit.path}`,
        reason: `config never stores caller-chosen refs (${hit.ref})`,
      })
    }
  }

  return errors
}

/**
 * Deep projection that masks every tainted ref reachable in an arbitrary JSON
 * value: a string equal to a ref becomes the marker, and a ref embedded
 * inside a longer string is masked in place (a ref is a capability — it must
 * never leave a sink, even as a substring of a rendered message). Objects
 * and arrays are copied; everything else passes through. This is the single
 * function every sink (API response mapper, worker interpolation, prompts,
 * messages, persisted samples) applies.
 */
export const redactWorkflowSecretValues = (
  value: unknown,
  refs: ReadonlySet<string>,
): unknown => {
  if (refs.size === 0) {
    return value
  }
  if (typeof value === 'string') {
    if (refs.has(value)) {
      return WORKFLOW_SECRET_REDACTION
    }
    let masked = value
    for (const ref of refs) {
      if (masked.includes(ref)) {
        masked = masked.split(ref).join(WORKFLOW_SECRET_REDACTION)
      }
    }
    return masked
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactWorkflowSecretValues(entry, refs))
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactWorkflowSecretValues(entry, refs),
      ]),
    )
  }
  return value
}

/**
 * The tainted-ref set for an installation: every `secret_*`-shaped string
 * reachable under `resolvedBindings`. This is deliberately value-shaped, not
 * schema-driven: the write gate already guarantees refs can only persist at
 * reference-typed keys, so a well-formed ref found anywhere is a capability
 * that must never leave a sink — including pre-boundary rows written before
 * the gate existed. The worker, which never loads the template's
 * bindingSchema, taints exactly the same set.
 */
export const collectWorkflowTaintedRefs = (
  resolvedBindings: unknown,
): Set<string> => {
  const refs = new Set<string>()
  for (const hit of collectSecretRefsInValue(resolvedBindings)) {
    refs.add(hit.ref)
  }
  return refs
}

/**
 * Member-visible projection of an installation's bindings/config: reference
 * binding values are replaced by the redaction marker (never the ref itself —
 * the ref is still a capability), everything else passes through.
 */
export const redactWorkflowInstallationSecrets = (
  value: unknown,
  bindingSchema: unknown,
): unknown => {
  const referenceKeys = collectWorkflowReferenceBindingKeys(bindingSchema)
  if (referenceKeys.size === 0 || !isPlainObject(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      referenceKeys.has(key) ? WORKFLOW_SECRET_REDACTION : entry,
    ]),
  )
}
