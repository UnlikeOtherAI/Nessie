/**
 * Data sources: creation, probe, refresh, and the write-only credential path.
 *
 * The credential rules here are the ones that keep "an agent may set a secret"
 * safe (plan §11.4):
 *
 * - plaintext is accepted once and immediately minted to a `secret_dashboard_*`
 *   reference; no read path returns the reference, the ciphertext, or a length;
 * - attaching a credential LOCKS the source's origin, method and auth
 *   placement. Changing any of them revokes the secret and disables refresh, so
 *   an existing credentialed source cannot be re-pointed at another host;
 * - there is no test/echo tool, so a secret cannot be read back through a
 *   diagnostic.
 *
 * Together those mean an agent can attach a key it was handed, and can never
 * obtain or redirect one that already exists — which was always the real
 * attack, not who is permitted to type.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  DashboardOutputColumnsSchema,
  type DashboardOutputColumn,
} from '@nessie/schemas'
import { compileSandboxedJmespath } from '@nessie/team-admin'
import {
  buildSourceUrl,
  probeDashboardSource,
  type DashboardEgressPolicy,
  type DashboardProbeResult,
} from '../index.js'
import { DashboardServiceError, type DashboardContext } from './dashboards.js'

export type CredentialStore = {
  /** Returns a server-minted ref. Plaintext never leaves this call. */
  put: (organizationId: string, plaintext: string) => Promise<string>
  delete: (ref: string) => Promise<void>
  resolve: (ref: string) => Promise<string | null>
}

const REFRESH_INTERVAL_PRESETS = [5, 15, 60, 360, 1440]

const assertColumns = (value: unknown): DashboardOutputColumn[] => {
  const parsed = DashboardOutputColumnsSchema.safeParse(value)
  if (!parsed.success) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_SOURCE_COLUMNS_INVALID',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}

const assertTransform = (transform: string): void => {
  const error = compileSandboxedJmespath(transform)
  if (error) {
    throw new DashboardServiceError(400, 'DASHBOARD_SOURCE_TRANSFORM_INVALID', error)
  }
}

const assertInterval = (mode: string, minutes: number | undefined): void => {
  if (mode === 'manual') {
    if (minutes != null) {
      throw new DashboardServiceError(
        400,
        'DASHBOARD_SOURCE_INTERVAL_INVALID',
        'a manual source carries no interval',
      )
    }
    return
  }
  if (!minutes || !REFRESH_INTERVAL_PRESETS.includes(minutes)) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_SOURCE_INTERVAL_INVALID',
      `interval must be one of ${REFRESH_INTERVAL_PRESETS.join(', ')} minutes`,
    )
  }
}

export type CreateSourceInput = {
  name: string
  origin: string
  path?: string
  queryParams?: Record<string, string | number | boolean>
  transform: string
  outputColumns?: unknown
  refreshMode?: 'manual' | 'interval'
  intervalMinutes?: number
  createdByType?: 'user' | 'agent'
}

export const createDashboardSource = async (
  context: DashboardContext,
  input: CreateSourceInput,
  policy: DashboardEgressPolicy,
) => {
  const { prisma, actor } = context
  const columns = assertColumns(input.outputColumns)
  assertTransform(input.transform)
  const refreshMode = input.refreshMode ?? 'manual'
  assertInterval(refreshMode, input.intervalMinutes)

  // Validated at write time as well as fetch time, so a source that could never
  // be fetched cannot be saved and left to fail silently on a schedule.
  buildSourceUrl({ origin: input.origin, path: input.path ?? '/' }, policy)

  try {
    return await prisma.dashboardDataSource.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        origin: input.origin,
        path: input.path ?? '/',
        queryParams: (input.queryParams ?? null) as Prisma.InputJsonValue,
        transform: input.transform,
        outputColumns: columns as unknown as Prisma.InputJsonValue,
        refreshMode,
        intervalMinutes: refreshMode === 'interval' ? (input.intervalMinutes ?? null) : null,
        nextRunAt: refreshMode === 'interval' ? new Date() : null,
        authorityUserId: actor.userId,
        createdByType: input.createdByType ?? 'user',
        createdBy: actor.userId,
      },
    })
  } catch (error) {
    // A duplicate name is an author mistake, not a server fault, and the
    // message has to name the collision or a caller cannot fix it.
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'P2002') {
      throw new DashboardServiceError(
        409,
        'DASHBOARD_SOURCE_NAME_TAKEN',
        `a data source named "${input.name}" already exists`,
      )
    }
    throw error
  }
}

export const listDashboardSources = async (context: DashboardContext) =>
  context.prisma.dashboardDataSource.findMany({
    where: { organizationId: context.actor.organizationId, archivedAt: null },
    orderBy: { name: 'asc' },
    // credentialRef is deliberately absent from every read path.
    select: {
      id: true,
      name: true,
      origin: true,
      path: true,
      outputColumns: true,
      transform: true,
      refreshMode: true,
      intervalMinutes: true,
      lastValidatedAt: true,
      lastErrorCode: true,
      authorityUserId: true,
      accessMode: true,
      credentialMode: true,
    },
  })

/**
 * Fetches once and returns a bounded sample. Never persists: a preview must not
 * quietly become the current data every viewer of a dashboard sees.
 */
export const probeSource = async (
  context: DashboardContext,
  input: {
    sourceId?: string
    origin?: string
    path?: string
    queryParams?: Record<string, string | number | boolean>
    transform?: string
    outputColumns?: unknown
  },
  policy: DashboardEgressPolicy,
  credentials: CredentialStore,
): Promise<DashboardProbeResult> => {
  const { prisma, actor } = context

  if (input.sourceId) {
    const source = await prisma.dashboardDataSource.findFirst({
      where: { id: input.sourceId, organizationId: actor.organizationId, archivedAt: null },
    })
    if (!source) {
      throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
    }
    const secret = source.credentialRef ? await credentials.resolve(source.credentialRef) : null
    return probeDashboardSource(
      {
        origin: source.origin,
        path: source.path,
        queryParams: source.queryParams as Record<string, string> | null,
        transform: input.transform ?? source.transform,
        columns: assertColumns(input.outputColumns ?? source.outputColumns),
        ...(secret && source.credentialMode
          ? {
            credential: {
              mode: source.credentialMode as 'bearer' | 'header',
              ...(source.credentialHeader ? { headerName: source.credentialHeader } : {}),
              value: secret,
            },
          }
          : {}),
      },
      policy,
    )
  }

  if (!input.origin || !input.transform || !input.outputColumns) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_PROBE_INCOMPLETE',
      'probing a new source needs origin, transform and outputColumns',
    )
  }
  assertTransform(input.transform)

  // A probe of an unsaved source never carries a credential: there is nowhere
  // to have stored one yet, and accepting plaintext here would be a second
  // secret path outside the encrypted store.
  return probeDashboardSource(
    {
      origin: input.origin,
      path: input.path ?? '/',
      queryParams: input.queryParams ?? null,
      transform: input.transform,
      columns: assertColumns(input.outputColumns),
    },
    policy,
  )
}

/**
 * Attaches or replaces a credential. Write-only by construction: the response
 * carries no part of the value, and the caller cannot supply a reference.
 */
export const setSourceCredential = async (
  context: DashboardContext,
  input: {
    sourceId: string
    mode: 'bearer' | 'header'
    headerName?: string
    plaintext: string
  },
  credentials: CredentialStore,
) => {
  const { prisma, actor } = context

  const source = await prisma.dashboardDataSource.findFirst({
    where: { id: input.sourceId, organizationId: actor.organizationId, archivedAt: null },
    select: { id: true, credentialRef: true },
  })
  if (!source) {
    throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
  }
  if (input.mode === 'header' && !input.headerName) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_CREDENTIAL_HEADER_REQUIRED',
      'header mode needs a header name',
    )
  }
  if (!input.plaintext.trim()) {
    throw new DashboardServiceError(400, 'DASHBOARD_CREDENTIAL_EMPTY', 'the credential is empty')
  }

  const ref = await credentials.put(actor.organizationId, input.plaintext)
  const previous = source.credentialRef

  await prisma.dashboardDataSource.update({
    where: { id: source.id },
    data: {
      credentialRef: ref,
      credentialMode: input.mode,
      credentialHeader: input.headerName ?? null,
      // The authority becomes whoever attached the key: refreshes now run under
      // their access, and that is what the audience is told.
      authorityUserId: actor.userId,
    },
  })

  if (previous) await credentials.delete(previous).catch(() => undefined)

  return { attached: true as const, mode: input.mode, headerName: input.headerName ?? null }
}

/**
 * Changing a credentialed source's origin revokes its secret.
 *
 * This is the control that makes "point Alice's key at my server"
 * inexpressible: the key does not follow the origin, it dies with it.
 */
export const updateSourceEndpoint = async (
  context: DashboardContext,
  input: { sourceId: string; origin?: string; path?: string },
  policy: DashboardEgressPolicy,
  credentials: CredentialStore,
) => {
  const { prisma, actor } = context
  const source = await prisma.dashboardDataSource.findFirst({
    where: { id: input.sourceId, organizationId: actor.organizationId, archivedAt: null },
  })
  if (!source) {
    throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
  }

  const nextOrigin = input.origin ?? source.origin
  const nextPath = input.path ?? source.path
  buildSourceUrl({ origin: nextOrigin, path: nextPath }, policy)

  const originChanged = nextOrigin !== source.origin
  if (originChanged && source.credentialRef) {
    await credentials.delete(source.credentialRef).catch(() => undefined)
  }

  return prisma.dashboardDataSource.update({
    where: { id: source.id },
    data: {
      origin: nextOrigin,
      path: nextPath,
      ...(originChanged && source.credentialRef
        ? {
          credentialRef: null,
          credentialMode: null,
          credentialHeader: null,
          refreshMode: 'manual' as const,
          intervalMinutes: null,
          nextRunAt: null,
          lastErrorCode: 'SOURCE_CREDENTIAL_REVOKED',
        }
        : {}),
    },
  })
}

export const resolveSourceCredential = async (
  source: { credentialRef: string | null; credentialMode: string | null; credentialHeader: string | null },
  credentials: CredentialStore,
) => {
  if (!source.credentialRef || !source.credentialMode) return null
  const value = await credentials.resolve(source.credentialRef)
  if (!value) return null
  return {
    mode: source.credentialMode as 'bearer' | 'header',
    ...(source.credentialHeader ? { headerName: source.credentialHeader } : {}),
    value,
  }
}

export type { PrismaClient }
