/**
 * Manifest schema for the `NessieToolBundle` format defined in
 * `docs/tool-registry-spec.md` §4.1.
 *
 * TODO(task:1): replace these local mirror types with imports from
 * `@nessie/schemas` once `packages/schemas/src/tools.ts` is published as part of
 * Slice B. Until then the schemas live here so this package stays self-contained.
 */

import { z } from 'zod'

// ─── enums (mirror of @nessie/schemas tools.ts) ──────────────────────────────

export const ToolSourceValues = [
  'builtin',
  'custom',
  'mcp-remote',
  'interactive-session',
] as const
export const ToolSourceSchema = z.enum(ToolSourceValues)
export type ToolSource = z.infer<typeof ToolSourceSchema>

export const ToolTransportValues = [
  'direct',
  'mcp',
  'stdio',
  'http',
  'pty',
] as const
export const ToolTransportSchema = z.enum(ToolTransportValues)
export type ToolTransport = z.infer<typeof ToolTransportSchema>

export const ToolGrantStateValues = ['inherit', 'allowed', 'denied'] as const
export const ToolGrantStateSchema = z.enum(ToolGrantStateValues)
export type ToolGrantState = z.infer<typeof ToolGrantStateSchema>

export const PromptMergeModeValues = ['append', 'prepend', 'replace'] as const
export const PromptMergeModeSchema = z.enum(PromptMergeModeValues)
export type PromptMergeMode = z.infer<typeof PromptMergeModeSchema>

export const CreatedByValues = ['system', 'role', 'agent'] as const
export const CreatedBySchema = z.enum(CreatedByValues)
export type CreatedBy = z.infer<typeof CreatedBySchema>

// ─── manifest schemas ────────────────────────────────────────────────────────

const JsonRecordSchema = z.record(z.string(), z.unknown())

const SignatureSchema = z
  .object({
    type: z.enum(['sha256', 'ed25519']),
    value: z.string().min(1, 'signature.value must not be empty'),
  })
  .strict()

const MetadataSchema = z
  .object({
    id: z.string().min(1, 'metadata.id must not be empty'),
    name: z.string().min(1, 'metadata.name must not be empty'),
    version: z.string().min(1, 'metadata.version must not be empty'),
    vendor: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    signature: SignatureSchema.optional(),
  })
  .strict()

const SandboxEnvSchema = z
  .object({
    allowVars: z.array(z.string()).optional(),
    denyVars: z.array(z.string()).optional(),
  })
  .strict()

const SandboxSchema = z
  .object({
    allowOutsideReadOnly: z.boolean().optional(),
    allowedRoots: z.array(z.string()).optional(),
    deniedPaths: z.array(z.string()).optional(),
    env: SandboxEnvSchema.optional(),
  })
  .strict()

const PolicySchema = z
  .object({
    defaultToolMode: ToolGrantStateSchema,
    defaultSandbox: SandboxSchema.optional(),
  })
  .strict()

const BasePromptSchema = z
  .object({
    content: z.string(),
    mergeMode: z.enum(PromptMergeModeValues),
  })
  .strict()

const CommonPromptSchema = z
  .object({
    enabledPrompt: z.string(),
    overrideMode: z.enum(PromptMergeModeValues),
  })
  .strict()

const GrantSchema = z
  .object({
    allowed: z.boolean(),
    config: JsonRecordSchema.optional(),
  })
  .strict()

const ToolEntrySchema = z
  .object({
    id: z.string().min(1, 'tool.id must not be empty'),
    toolName: z.string().min(1, 'tool.toolName must not be empty'),
    label: z.string().min(1, 'tool.label must not be empty'),
    overview: z.string().min(1, 'tool.overview must not be empty'),
    instructions: z.string().optional(),
    source: ToolSourceSchema,
    transport: ToolTransportSchema,
    transportConfig: JsonRecordSchema.optional(),
    inputSchema: JsonRecordSchema,
    enabled: z.boolean().optional(),
    grants: GrantSchema.optional(),
    basePrompt: BasePromptSchema.optional(),
    commonPrompt: CommonPromptSchema.optional(),
    tags: z.array(z.string()).optional(),
    baseSearchTerms: z.array(z.string()).optional(),
    allowSearchTerms: z.array(z.string()).optional(),
    createdBy: CreatedBySchema.optional(),
    owner: z.string().optional(),
  })
  .strict()

export const NessieToolBundleSchema = z
  .object({
    apiVersion: z.literal('toolset.nessie.io/v1'),
    kind: z.literal('NessieToolBundle'),
    metadata: MetadataSchema,
    policy: PolicySchema.optional(),
    tools: z
      .array(ToolEntrySchema)
      .min(1, 'bundle must declare at least one tool'),
  })
  .strict()

export type NessieToolBundleSignature = z.infer<typeof SignatureSchema>
export type NessieToolBundleMetadata = z.infer<typeof MetadataSchema>
export type NessieToolBundleTool = z.infer<typeof ToolEntrySchema>
export type NessieToolBundlePolicy = z.infer<typeof PolicySchema>
export type NessieToolBundle = z.infer<typeof NessieToolBundleSchema>

// ─── normalized record ───────────────────────────────────────────────────────

/**
 * A single tool ready to be written into `ToolRegistryEntry`. The connectors
 * package does NOT perform the DB write — the caller wires this into Prisma.
 *
 * Field order is intentionally stable so callers can hash these records for
 * change detection (`JSON.stringify` produces deterministic output).
 */
export type NormalizedTool = {
  /** Manifest-local id; pair with `bundleSourceId` for a globally unique key. */
  id: string
  bundleId: string
  bundleName: string
  bundleVersion: string
  toolName: string
  label: string
  overview: string
  instructions: string
  source: ToolSource
  transport: ToolTransport
  transportConfig: Record<string, unknown>
  inputSchema: Record<string, unknown>
  enabled: boolean
  grant: { allowed: boolean; config: Record<string, unknown> } | null
  basePrompt: { content: string; mergeMode: PromptMergeMode }
  commonPrompt: { enabledPrompt: string; overrideMode: PromptMergeMode } | null
  tags: string[]
  baseSearchTerms: string[]
  allowSearchTerms: string[]
  createdBy: CreatedBy
  owner: string
}

export type SignatureSupport = 'verified' | 'absent' | 'unimplemented'

export type ManifestValidationWarning = {
  code: 'signatureUnimplemented'
  message: string
}

export type ManifestValidationOk = {
  ok: true
  bundle: NessieToolBundle
  signatureSupport: SignatureSupport
  warnings: ManifestValidationWarning[]
}
