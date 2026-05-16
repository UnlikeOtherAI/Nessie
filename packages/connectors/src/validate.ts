import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  ManifestValidationError,
  type ManifestErrorIssue,
} from './errors.js'
import {
  NessieToolBundleSchema,
  type ManifestValidationOk,
  type ManifestValidationWarning,
  type NessieToolBundle,
  type SignatureSupport,
} from './types.js'

export type ValidationResult =
  | ManifestValidationOk
  | { ok: false; errors: ManifestErrorIssue[] }

/**
 * Validate a parsed manifest value against the `NessieToolBundle` schema and
 * (when present) verify its signature. Returns a discriminated union so callers
 * can branch on `ok` without catching exceptions. The strict variant
 * (`validateManifestOrThrow`) is provided for callers that prefer exceptions.
 */
export const validateManifest = (value: unknown): ValidationResult => {
  const parsed = NessieToolBundleSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToErrors(parsed.error) }
  }

  const signatureResult = verifySignature(parsed.data)
  if (!signatureResult.ok) {
    return { ok: false, errors: signatureResult.errors }
  }

  return {
    ok: true,
    bundle: parsed.data,
    signatureSupport: signatureResult.support,
    warnings: signatureResult.warnings,
  }
}

export const validateManifestOrThrow = (
  value: unknown,
): ManifestValidationOk => {
  const result = validateManifest(value)
  if (!result.ok) {
    throw new ManifestValidationError(
      'manifest failed schema or signature validation',
      result.errors,
    )
  }
  return result
}

// ─── signature ───────────────────────────────────────────────────────────────

type SignatureVerification =
  | {
      ok: true
      support: SignatureSupport
      warnings: ManifestValidationWarning[]
    }
  | { ok: false; errors: ManifestErrorIssue[] }

const verifySignature = (bundle: NessieToolBundle): SignatureVerification => {
  const signature = bundle.metadata.signature
  if (!signature) {
    return { ok: true, support: 'absent', warnings: [] }
  }

  if (signature.type === 'sha256') {
    const expected = computeSha256(bundle)
    if (expected !== signature.value.toLowerCase()) {
      return {
        ok: false,
        errors: [
          {
            path: 'metadata.signature.value',
            message:
              `sha256 signature mismatch (expected ${expected}, ` +
              `got ${signature.value})`,
          },
        ],
      }
    }
    return { ok: true, support: 'verified', warnings: [] }
  }

  // ed25519 stub — accepted with a typed warning so the caller can surface a
  // banner in the UI without crashing the import.
  return {
    ok: true,
    support: 'unimplemented',
    warnings: [
      {
        code: 'signatureUnimplemented',
        message:
          'ed25519 signatures are not yet verified; manifest accepted as ' +
          'unsigned for now',
      },
    ],
  }
}

/**
 * Compute the SHA-256 of the canonical JSON encoding of the manifest with the
 * `metadata.signature` block omitted. Object keys are sorted recursively so
 * the same logical payload always hashes to the same digest regardless of
 * source format (JSON / YAML / Markdown frontmatter).
 */
const computeSha256 = (bundle: NessieToolBundle): string => {
  const cloned = structuredClone(bundle) as NessieToolBundle & {
    metadata: { signature?: unknown }
  }
  delete cloned.metadata.signature
  const canonical = canonicalJson(cloned)
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Deterministic JSON encoder: object keys sorted lexicographically, arrays
 * preserved in order, no whitespace. `undefined` values are dropped to match
 * standard JSON semantics.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')
    return `{${body}}`
  }
  // numbers handled above; undefined / function / symbol fall through to null
  return 'null'
}

const zodIssuesToErrors = (error: z.ZodError): ManifestErrorIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }))

/** Exported only so `normalize.ts` can re-use the canonicaliser for hashing. */
export const __canonicalJsonForHashing = canonicalJson
