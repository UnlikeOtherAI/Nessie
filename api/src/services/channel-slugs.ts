import { Prisma, type PrismaClient } from '@prisma/client'

export type ChannelLabelParts = {
  label: string
  slug: string
}

export type ChannelTeamProject = {
  organizationId: string
  projectId: string
}

export class ChannelValidationError extends Error {}

export class ChannelSlugConflictError extends Error {
  constructor(slug: string) {
    super(`A channel with slug "${slug}" already exists in this project`)
  }
}

// sp-channels: mirror of the admin `toSlug` rules. Channel labels are validated
// server-side so the API never persists a name the admin UI would reject.
export const toChannelSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

export const validateChannelLabel = (label: string): ChannelLabelParts => {
  const trimmed = label.trim()
  const slug = toChannelSlug(trimmed)
  if (slug.length === 0) {
    throw new ChannelValidationError(
      'Channel name must contain at least one letter or number',
    )
  }
  return { label: trimmed, slug }
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
  }
}

export const ensureChannelSlugAvailable = async (
  prisma: PrismaClient,
  input: {
    excludeChannelId?: string
    projectId: string
    slug: string
  },
): Promise<void> => {
  const existing = await prisma.channel.findFirst({
    where: {
      projectId: input.projectId,
      slug: input.slug,
      type: 'standard',
      ...(input.excludeChannelId ? { id: { not: input.excludeChannelId } } : {}),
    },
    select: { id: true },
  })
  if (existing) {
    throw new ChannelSlugConflictError(input.slug)
  }
}

export const throwIfChannelSlugConflict = (
  error: unknown,
  slug: string,
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
    throw new ChannelSlugConflictError(slug)
  }
  throw error
}
