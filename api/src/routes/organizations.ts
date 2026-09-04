import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { recordStorageTransferUsage } from '@nessie/runtime'

import {
  type AuthorizedActionContext,
  OrganizationSummarySchema,
  UpdateOrganizationRequestSchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { canAccessAttachment } from '../services/attachments.js'
import {
  renameUoaOrganization,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import {
  resolveOrganizationAdministrationAccess,
  type OrganizationAdministrationAccess,
} from '../services/uoa-organization-administration.js'
import type { RouteDeps } from './types.js'

// Logos are served from a public, unauthenticated endpoint and rendered on the
// login screen, so restrict them to raster image types. This excludes SVG —
// which can carry scripts and would execute as XSS if the public endpoint were
// opened directly. The in-app cropper always produces image/png.
const SAFE_LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * `rosterDeps` is the injectable egress seam (pinned fetch + DNS) for the one
 * upstream call this file makes — renaming a UOA-bound organisation. Production
 * passes nothing; it mirrors `registerTeamMembersRoutes`.
 */
export const registerOrganizationRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  /**
   * Relay a rename to UnlikeOtherAI and answer with the name UOA stored, or
   * `null` once a refusal has been written to `reply`.
   *
   * A local-mode organisation (`externalOrgId` null — a no-IdP install or the
   * generic-OIDC shared org) has no upstream authority over its name, so it
   * keeps writing locally, byte-for-byte as before.
   */
  const renameOnUnlikeOtherAI = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: { actorContext: AuthorizedActionContext; name: string; organizationId: string },
  ): Promise<string | null> => {
    const organization = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { externalOrgId: true },
    })
    if (!organization?.externalOrgId) return input.name

    // The assertion UOA verifies names the caller's active org AND team, so the
    // relay needs the session team's UOA mapping — and it must be a mapping of
    // *this* organisation, never a team the session drifted onto.
    const team = await resolveUoaRosterTeam(prisma, {
      organizationId: input.organizationId,
      teamId: input.actorContext.tenant.teamId ?? input.actorContext.actionContext.teamId,
    })
    if (!team || team.externalOrgId !== organization.externalOrgId) {
      sendApiError(
        reply,
        403,
        'UOA_SESSION_REQUIRED',
        'This organisation is managed by UnlikeOtherAI. Sign in with UnlikeOtherAI and select '
          + 'this team to rename it.',
      )
      return null
    }

    try {
      return await renameUoaOrganization(
        team,
        input.name,
        withUoaRosterSubjectAssertion(
          team,
          input.actorContext.actionContext.uoaIdentity,
          rosterDeps,
        ),
      )
    } catch (error) {
      if (error instanceof UoaRosterIdentityError) {
        sendApiError(
          reply,
          403,
          'UOA_SESSION_REQUIRED',
          'This organisation is managed by UnlikeOtherAI. Sign in with UnlikeOtherAI and select '
            + 'this team to rename it.',
        )
        return null
      }
      if (error instanceof UoaRosterRejectedError) {
        // UOA re-resolves the caller's live capability and its own name rules,
        // so its refusal is the answer — never a reason to write locally.
        sendApiError(
          reply,
          error.statusCode === 403 || error.statusCode === 404 ? error.statusCode : 400,
          'ORGANIZATION_RENAME_REJECTED',
          'UnlikeOtherAI refused the rename. You may not have permission to rename this '
            + 'organisation there.',
        )
        return null
      }
      if (error instanceof UoaRosterUnavailableError) {
        request.log.warn({ err: error }, 'uoa organisation rename relay failed')
        sendApiError(
          reply,
          502,
          'UOA_DIRECTORY_UNAVAILABLE',
          'The UnlikeOtherAI directory is temporarily unavailable',
        )
        return null
      }
      throw error
    }
  }

  const requireOrganizationAdministrator = (
    reply: FastifyReply,
    access: OrganizationAdministrationAccess,
  ): boolean => {
    if (access.status === 'allowed') return true
    if (access.status === 'unavailable') {
      sendApiError(
        reply,
        503,
        'UOA_ORGANIZATION_ACCESS_UNAVAILABLE',
        'UnlikeOtherAI could not confirm organisation administrator access. Try again shortly.',
      )
      return false
    }
    sendApiError(
      reply,
      403,
      'ORGANIZATION_ADMIN_REQUIRED',
      'Organisation administrator access is required.',
    )
    return false
  }

  app.get('/api/organizations/current', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } })
    if (!organization) {
      sendApiError(reply, 404, 'ORGANIZATION_NOT_FOUND', 'Organization not found')
      return reply
    }

    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    const administration = await resolveOrganizationAdministrationAccess(
      { actorContext, localRole: membership?.role ?? null, organization },
      rosterDeps,
    )

    return createApiResponse(
      OrganizationSummarySchema.parse({
        id: organization.id,
        name: organization.name,
        role: membership?.role ?? 'member',
        logoAttachmentId: organization.logoAttachmentId ?? null,
        stripImageMetadata: organization.stripImageMetadata,
        nameManagedExternally: organization.externalOrgId !== null,
        administration,
      }),
    )
  })

  app.patch('/api/organizations/current', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId

    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    const organizationBinding = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { externalOrgId: true },
    })
    if (!organizationBinding) {
      sendApiError(reply, 404, 'ORGANIZATION_NOT_FOUND', 'Organization not found')
      return reply
    }
    const administration = await resolveOrganizationAdministrationAccess(
      { actorContext, localRole: membership?.role ?? null, organization: organizationBinding },
      rosterDeps,
    )
    if (!requireOrganizationAdministrator(reply, administration)) return reply

    const body = parseInput(UpdateOrganizationRequestSchema, request.body, reply)
    if (!body) return reply

    if (body.logoAttachmentId) {
      const attachment = await prisma.attachment.findUnique({
        where: { id: body.logoAttachmentId },
      })
      if (
        !attachment ||
        !(await canAccessAttachment(prisma, attachment, { organizationId, userId }))
      ) {
        sendApiError(
          reply,
          400,
          'INVALID_ATTACHMENT',
          'Logo attachment not found for this organisation',
        )
        return reply
      }
      if (!SAFE_LOGO_MIMES.has(attachment.mime)) {
        sendApiError(
          reply,
          400,
          'INVALID_ATTACHMENT',
          'Logo must be a PNG, JPEG, WebP or GIF image',
        )
        return reply
      }
    }

    // A rename of a UOA-bound organisation is UOA's write, not ours. It is
    // relayed BEFORE the local row is touched: `Organization.name` is a mirror
    // of UOA's `orgName`, and a local-only write both left every other product
    // (UOA's own team chooser included) on the old name and was reverted
    // by the next login's directory sync. A refusal or outage upstream
    // therefore changes nothing locally.
    let mirroredName = body.name
    if (body.name !== undefined) {
      const relayed = await renameOnUnlikeOtherAI(request, reply, {
        actorContext,
        name: body.name,
        organizationId,
      })
      if (relayed === null) return reply
      mirroredName = relayed
    }

    // Each field is optional; only apply what was sent so a name-only PATCH
    // leaves the logo and metadata-stripping flag intact and vice versa.
    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(mirroredName !== undefined ? { name: mirroredName } : {}),
        ...(body.logoAttachmentId !== undefined ? { logoAttachmentId: body.logoAttachmentId } : {}),
        ...(body.stripImageMetadata !== undefined
          ? { stripImageMetadata: body.stripImageMetadata }
          : {}),
      },
    })

    return createApiResponse(
      OrganizationSummarySchema.parse({
        id: organization.id,
        name: organization.name,
        role: membership?.role ?? 'member',
        logoAttachmentId: organization.logoAttachmentId ?? null,
        stripImageMetadata: organization.stripImageMetadata,
        nameManagedExternally: organization.externalOrgId !== null,
        administration,
      }),
    )
  })

  // Public branding endpoint: the sign-in screen runs unauthenticated and is
  // instance state, not tenant state, so the organisation whose mark it carries
  // is designated by the instance operator (`nessie set-instance-brand`) — never
  // by an org admin, and never inferred from "the instance happens to hold one
  // organisation" (routinely false under per-UOA-org tenancy, and it handed one
  // tenant control of everybody's login screen). No designation and unset logos
  // return 404 so the client falls back to the static Nessie brand icon (an
  // `<img onError>`), mirroring GET /icon.png.
  app.get('/api/brand/logo', { config: { public: true } }, async (_request, reply) => {
    const startedAt = Date.now()
    const organization = await prisma.organization.findFirst({
      where: { instanceBrand: true, logoAttachmentId: { not: null } },
      orderBy: { createdAt: 'asc' },
    })
    if (!organization?.logoAttachmentId) {
      sendApiError(reply, 404, 'BRAND_LOGO_NOT_FOUND', 'No brand logo configured')
      return reply
    }

    const opened = await deps.fileService.openStream(
      organization.logoAttachmentId,
      organization.id,
    )
    if (!opened) {
      sendApiError(reply, 404, 'BRAND_LOGO_NOT_FOUND', 'No brand logo bytes found')
      return reply
    }

    // PATCH guarantees a safe raster MIME, but pin + nosniff defensively since
    // this is public and unauthenticated.
    const mime = SAFE_LOGO_MIMES.has(opened.attachment.mime) ? opened.attachment.mime : 'image/png'
    reply.header('content-type', mime)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('cache-control', 'public, max-age=60')
    void recordStorageTransferUsage(prisma, {
      attribution: {
        organizationId: organization.id,
        actorId: 'public',
        actorType: 'system',
      },
      bytes: Number(opened.attachment.sizeBytes),
      latencyMs: Date.now() - startedAt,
      metadata: { attachmentId: opened.attachment.id, source: 'api.brand.logo' },
      operation: 'download',
    }).catch(() => undefined)
    return reply.send(opened.stream)
  })
}
