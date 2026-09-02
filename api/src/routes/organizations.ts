import type { FastifyInstance } from 'fastify'
import { recordStorageTransferUsage } from '@nessie/runtime'

import {
  isAdminRole,
  OrganizationSummarySchema,
  SetConversationalSetupEnabledRequestSchema,
  UpdateOrganizationRequestSchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { canAccessAttachment } from '../services/attachments.js'
import type { RouteDeps } from './types.js'

// Logos are served from a public, unauthenticated endpoint and rendered on the
// login screen, so restrict them to raster image types. This excludes SVG —
// which can carry scripts and would execute as XSS if the public endpoint were
// opened directly. The in-app cropper always produces image/png.
const SAFE_LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export const registerOrganizationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

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

    return createApiResponse(
      OrganizationSummarySchema.parse({
        id: organization.id,
        name: organization.name,
        role: membership?.role ?? 'member',
        logoAttachmentId: organization.logoAttachmentId ?? null,
        stripImageMetadata: organization.stripImageMetadata,
        conversationalSetupEnabled: organization.conversationalSetupEnabled,
        nameManagedExternally: organization.externalOrgId !== null,
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
    // Only owners/admins may change the org-wide logo (members get a read-only view).
    if (!membership || !isAdminRole(membership.role)) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only organisation owners and admins can change organisation settings',
      )
      return reply
    }

    const body = parseInput(UpdateOrganizationRequestSchema, request.body, reply)
    if (!body) return reply

    // The name of a UOA-bound organisation is UOA's, and `Organization.name` is
    // only a mirror of it — `syncExternalOrganizationNames` overwrites it from
    // the verified directory at every login and rotation. Accepting the write
    // here made Nessie a second, losing authority: the value persisted, the
    // person saw it saved, and a later refresh silently reverted it. Refuse in
    // words instead, naming where the name actually lives. The logo and the
    // metadata flag below are Nessie's own and stay editable.
    if (body.name !== undefined) {
      const bound = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { externalOrgId: true, name: true },
      })
      if (bound?.externalOrgId && body.name !== bound.name) {
        sendApiError(
          reply,
          409,
          'ORGANIZATION_NAME_MANAGED_BY_SSO',
          'This organisation is named in UnlikeOtherAI. Rename it there and the change will appear here.',
        )
        return reply
      }
    }

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

    // Each field is optional; only apply what was sent so a name-only PATCH
    // leaves the logo and metadata-stripping flag intact and vice versa.
    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
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
        role: membership.role,
        logoAttachmentId: organization.logoAttachmentId ?? null,
        stripImageMetadata: organization.stripImageMetadata,
        conversationalSetupEnabled: organization.conversationalSetupEnabled,
        nameManagedExternally: organization.externalOrgId !== null,
      }),
    )
  })

  // This setting deliberately does not share the generic organization PATCH:
  // ordinary profile changes permit owners and admins, while this early-access
  // gate is mutable only by a presently active owner.
  app.put('/api/organizations/current/features/conversational-setup', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(SetConversationalSetupEnabledRequestSchema, request.body, reply)
    if (!body) return reply

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const membership = await prisma.organizationMember.findFirst({
      where: {
        organizationId,
        userId,
        role: 'owner',
        deactivatedAt: null,
      },
    })
    if (!membership) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only active organisation owners can change conversational agent setup early access',
      )
      return reply
    }

    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: { conversationalSetupEnabled: body.conversationalSetupEnabled },
    })

    return createApiResponse(
      OrganizationSummarySchema.parse({
        id: organization.id,
        name: organization.name,
        role: membership.role,
        logoAttachmentId: organization.logoAttachmentId ?? null,
        stripImageMetadata: organization.stripImageMetadata,
        conversationalSetupEnabled: organization.conversationalSetupEnabled,
        nameManagedExternally: organization.externalOrgId !== null,
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
