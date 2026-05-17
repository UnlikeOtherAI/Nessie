import type { PrismaClient } from '@prisma/client'
import {
  ManifestParseError,
  ManifestValidationError,
  normalizeBundle,
  parseManifest,
  type ManifestFormat,
  type NormalizedTool,
  validateManifestOrThrow,
} from '@nessie/connectors'
import type { AuthorizedActionContext, ToolBundleStatus } from '@nessie/schemas'

/**
 * Tool bundle import service.
 *
 * Spec: `docs/tool-registry-spec.md` §4.1/§11.1 + plan §6 (`tools-bundles`).
 *
 * Admins upload a `NessieToolBundle` manifest (JSON/YAML/MD body). On success
 * we persist a `ToolBundle` row and project one `ToolRegistryEntry` per declared
 * tool at `status: 'pending_review'` (plan D9), `transport: tool.transport`,
 * `transportConfig` straight from the manifest. The bundle itself is also held
 * at `status: 'pending_review'` until an admin transitions it.
 */

export const TOOL_BUNDLE_ERROR_CODES = {
  PARSE_FAILED: 'TOOL_BUNDLE_PARSE_FAILED',
  VALIDATION_FAILED: 'TOOL_BUNDLE_VALIDATION_FAILED',
  DUPLICATE: 'TOOL_BUNDLE_DUPLICATE',
  NOT_FOUND: 'TOOL_BUNDLE_NOT_FOUND',
} as const

export class ToolBundleError extends Error {
  override readonly name = 'ToolBundleError'

  constructor(
    public readonly code: string,
    message: string,
    public readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message)
  }
}

export type ToolBundleRow = {
  id: string
  organizationId: string
  apiVersion: string
  bundleName: string
  version: string
  vendor: string | null
  sourceUrl: string | null
  license: string | null
  signatureType: string | null
  signatureValue: string | null
  policy: unknown
  status: ToolBundleStatus
  importedBy: string
  createdAt: Date
  updatedAt: Date
}

export type ImportBundleInput = {
  body: string | Buffer
  format?: ManifestFormat
}

export type ImportBundleResult = {
  bundle: ToolBundleRow
  toolCount: number
  warnings: Array<{ code: string; message: string }>
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === 'P2002'

const scopeKeyFor = (organizationId: string, bundleId: string): string =>
  `bundle:${organizationId}:${bundleId}`

/**
 * Bundle imports do NOT auto-approve. Tools always land in
 * `pending_review` and require an explicit admin transition (D9).
 */
export const importBundle = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: ImportBundleInput,
): Promise<ImportBundleResult> => {
  let parsed: unknown
  try {
    parsed = parseManifest(input.body, input.format)
  } catch (error) {
    if (error instanceof ManifestParseError) {
      throw new ToolBundleError(
        TOOL_BUNDLE_ERROR_CODES.PARSE_FAILED,
        `Failed to parse manifest: ${error.message}`,
      )
    }
    throw error
  }

  let validated: ReturnType<typeof validateManifestOrThrow>
  try {
    validated = validateManifestOrThrow(parsed)
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw new ToolBundleError(
        TOOL_BUNDLE_ERROR_CODES.VALIDATION_FAILED,
        `Manifest failed validation: ${error.message}`,
        error.issues,
      )
    }
    throw error
  }

  const { bundle, warnings } = validated
  const tools = normalizeBundle(bundle)
  const organizationId = actorContext.tenant.organizationId

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.toolBundle.create({
        data: {
          organizationId,
          apiVersion: bundle.apiVersion,
          bundleName: bundle.metadata.name,
          version: bundle.metadata.version,
          vendor: bundle.metadata.vendor ?? null,
          sourceUrl: bundle.metadata.source ?? null,
          license: bundle.metadata.license ?? null,
          signatureType: bundle.metadata.signature?.type ?? null,
          signatureValue: bundle.metadata.signature?.value ?? null,
          policy: (bundle.policy ?? {}) as object,
          status: 'pending_review',
          importedBy: actorContext.actor.actorId,
        },
      })

      const scopeKey = scopeKeyFor(organizationId, created.id)
      for (const tool of tools) {
        await projectBundleTool(tx, {
          bundleId: created.id,
          organizationId,
          scopeKey,
          tool,
        })
      }

      return {
        bundle: created,
        toolCount: tools.length,
        warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ToolBundleError(
        TOOL_BUNDLE_ERROR_CODES.DUPLICATE,
        `A tool bundle named "${bundle.metadata.name}@${bundle.metadata.version}"`
          + ' already exists in this organization',
      )
    }
    throw error
  }
}

type BundleToolProjection = {
  bundleId: string
  organizationId: string
  scopeKey: string
  tool: NormalizedTool
}

/**
 * `Prisma.TransactionClient` would be the precise type, but it's not exported
 * from `@prisma/client`'s top-level surface in every version. The structural
 * `Pick` keeps the call site honest without an `any` cast.
 */
type TxClient = Pick<PrismaClient, 'toolRegistryEntry'>

const projectBundleTool = async (
  tx: TxClient,
  input: BundleToolProjection,
): Promise<void> => {
  const toolId = `bundle:${input.bundleId}:${input.tool.toolName}`
  await tx.toolRegistryEntry.upsert({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId: input.organizationId,
        scopeKey: input.scopeKey,
        toolId,
      },
    },
    create: {
      organizationId: input.organizationId,
      scopeKey: input.scopeKey,
      toolId,
      label: input.tool.label,
      description: input.tool.overview,
      safe: false,
      builtin: false,
      enabled: input.tool.enabled,
      handlerKind: input.tool.transport === 'direct' ? 'builtin' : 'bundle',
      metadata: {} as object,
      source: 'custom',
      transport: input.tool.transport,
      transportConfig: input.tool.transportConfig as object,
      bundleId: input.bundleId,
      inputSchema: input.tool.inputSchema as object,
      tags: input.tool.tags,
      status: 'pending_review',
      version: input.tool.bundleVersion,
      createdBy: input.tool.createdBy,
    },
    update: {
      label: input.tool.label,
      description: input.tool.overview,
      enabled: input.tool.enabled,
      transport: input.tool.transport,
      transportConfig: input.tool.transportConfig as object,
      inputSchema: input.tool.inputSchema as object,
      tags: input.tool.tags,
      version: input.tool.bundleVersion,
      // Re-imports require a fresh review per spec §11.1.
      status: 'pending_review',
    },
  })
}

export const listBundles = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: { status?: ToolBundleStatus } = {},
): Promise<ToolBundleRow[]> => {
  return prisma.toolBundle.findMany({
    where: {
      organizationId,
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })
}

export const getBundle = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<ToolBundleRow | null> => {
  return prisma.toolBundle.findFirst({
    where: { id, organizationId },
  })
}

export const deleteBundle = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<boolean> => {
  const existing = await getBundle(prisma, organizationId, id)
  if (!existing) return false
  await prisma.toolBundle.delete({ where: { id } })
  return true
}

export const transitionBundleStatus = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  status: ToolBundleStatus,
): Promise<ToolBundleRow | null> => {
  const existing = await getBundle(prisma, organizationId, id)
  if (!existing) return null
  // Promote/disable cascades into the projected tool rows so callers see a
  // consistent state without a second admin step.
  return prisma.$transaction(async (tx) => {
    const updated = await tx.toolBundle.update({
      where: { id },
      data: { status },
    })
    const scopeKey = scopeKeyFor(organizationId, id)
    if (status === 'approved') {
      await tx.toolRegistryEntry.updateMany({
        where: { scopeKey, bundleId: id, status: 'pending_review' },
        data: { status: 'active' },
      })
    } else if (status === 'rejected' || status === 'disabled') {
      await tx.toolRegistryEntry.updateMany({
        where: { scopeKey, bundleId: id },
        data: { status: 'disabled' },
      })
    }
    return updated
  })
}
