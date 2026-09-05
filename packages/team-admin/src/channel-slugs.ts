import { toChannelSlug } from '@nessie/schemas'
import { Prisma, type PrismaClient } from '@prisma/client'

export type ChannelLabelParts = {
  label: string
  slug: string
}

export type ChannelTeamProject = {
  organizationId: string
  projectId: string
  teamId: string
}

export class ChannelValidationError extends Error {}

export type ChannelSlugScope = 'project' | 'standalone'

export type ChannelSlugConflictIntent = 'claim' | 'restore'

export class ChannelSlugConflictError extends Error {
  constructor(
    slug: string,
    scope: ChannelSlugScope = 'project',
    intent: ChannelSlugConflictIntent = 'claim',
  ) {
    const holder = scope === 'standalone'
      ? `A standalone channel with slug "${slug}" already exists`
      : `A channel with slug "${slug}" already exists in this project`
    super(
      intent === 'restore'
        ? `${holder}. Rename that channel, or rename this one, before unarchiving`
        : holder,
    )
  }
}

export { toChannelSlug }

// Channel names are always the canonical slug form: lowercase, hyphen-separated,
// no special characters. The label and the slug are deliberately the same string
// — a channel has one name, and it is the addressable one — so whatever a caller
// submits is normalized here rather than stored as typed. This is the single
// chokepoint every write goes through (create, rename, DM promotion), so no path
// can persist a name that breaks the rule.
export const validateChannelLabel = (label: string): ChannelLabelParts => {
  const slug = toChannelSlug(label)
  if (slug.length === 0) {
    throw new ChannelValidationError(
      'Channel name must contain at least one letter or number',
    )
  }
  return { label: slug, slug }
}

export const loadChannelTeamProject = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
  },
): Promise<ChannelTeamProject | null> => {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      project: {
        select: { id: true, organizationId: true },
      },
    },
  })
  if (team?.project.organizationId !== input.organizationId) {
    return null
  }
  return {
    organizationId: team.project.organizationId,
    projectId: team.project.id,
    teamId: input.teamId,
  }
}

/**
 * Which namespace a channel's name is unique in, read from where the channel
 * lives rather than from what the caller believes: standalone (shared) channels
 * sit in the organisation's hidden channel-root project, project channels in a
 * real one. Renaming and unarchiving both need this, and neither is told a
 * scope by its caller — asking the row is the only way the message about the
 * conflict names the place the person is actually looking at.
 */
export const resolveChannelSlugScope = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<ChannelSlugScope> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { channelRoot: true },
  })
  return project?.channelRoot ? 'standalone' : 'project'
}

/**
 * An archived channel does not hold its name.
 *
 * `DELETE /api/channels/:id` archives rather than hard-deletes, and the sidebar
 * hides archived channels, so before this the only trace of a deleted `#random`
 * was the refusal to create a new one — a conflict with a channel nobody could
 * see, open, or rename. The partial unique index carries the same `archived_at
 * IS NULL` condition, so the database agrees rather than overruling this.
 *
 * The cost is that unarchiving can now collide; `setChannelArchived` re-checks
 * on the way back and says so rather than failing on the constraint.
 */
export const ensureChannelSlugAvailable = async (
  prisma: PrismaClient,
  input: {
    excludeChannelId?: string
    intent?: ChannelSlugConflictIntent
    projectId: string
    scope?: ChannelSlugScope
    slug: string
  },
): Promise<void> => {
  const existing = await prisma.channel.findFirst({
    where: {
      archivedAt: null,
      projectId: input.projectId,
      slug: input.slug,
      type: 'standard',
      ...(input.excludeChannelId ? { id: { not: input.excludeChannelId } } : {}),
    },
    select: { id: true },
  })
  if (existing) {
    throw new ChannelSlugConflictError(input.slug, input.scope, input.intent)
  }
}

export const throwIfChannelSlugConflict = (
  error: unknown,
  slug: string,
  scope: ChannelSlugScope = 'project',
  intent: ChannelSlugConflictIntent = 'claim',
): never => {
  const target = error instanceof Prisma.PrismaClientKnownRequestError
    ? error.meta?.['target']
    : undefined
  if (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && (
      target === 'channels_project_slug_standard_key'
      || (Array.isArray(target) && target.includes('channels_project_slug_standard_key'))
      || (Array.isArray(target) && target.includes('project_id') && target.includes('slug'))
    )
  ) {
    throw new ChannelSlugConflictError(slug, scope, intent)
  }
  throw error
}
