import type {
  AuthorizedActionContext,
  ThoughtAudienceType,
  ThoughtVisibility,
} from '@nessie/schemas'

type ScopedThoughtContext = {
  audienceType?: ThoughtAudienceType
  visibility?: ThoughtVisibility
  projectId?: string
  teamId?: string
  channelId?: string
}

export type ResolvedThoughtAudience = {
  audienceType: ThoughtAudienceType
  audienceId: string
  visibility: ThoughtVisibility
}

type AudienceResolutionResult =
  | { audience: ResolvedThoughtAudience; error?: never }
  | { audience?: never; error: string }

const AUDIENCE_TYPE_BY_VISIBILITY: Record<ThoughtVisibility, ThoughtAudienceType> = {
  private: 'user',
  channel: 'channel',
  team: 'team',
  project: 'project',
  organization: 'organization',
}

const VISIBILITY_BY_AUDIENCE_TYPE: Record<ThoughtAudienceType, ThoughtVisibility> = {
  user: 'private',
  channel: 'channel',
  team: 'team',
  project: 'project',
  organization: 'organization',
}

const resolveAudienceId = (
  audienceType: ThoughtAudienceType,
  actorContext: AuthorizedActionContext,
  scoped: Omit<ScopedThoughtContext, 'audienceType' | 'visibility'>,
): string | null => {
  switch (audienceType) {
    case 'user':
      return actorContext.actor.actorType === 'user'
        ? actorContext.actor.actorId
        : null
    case 'channel':
      return scoped.channelId ?? null
    case 'team':
      return scoped.teamId ?? null
    case 'project':
      return scoped.projectId ?? null
    case 'organization':
      return actorContext.tenant.organizationId
  }
}

const defaultCaptureAudienceType = (
  actorContext: AuthorizedActionContext,
  scoped: Omit<ScopedThoughtContext, 'audienceType' | 'visibility'>,
): ThoughtAudienceType => {
  if (scoped.channelId) {
    return 'channel'
  }

  return actorContext.actor.actorType === 'user'
    ? 'user'
    : 'organization'
}

export const resolveThoughtCaptureAudience = (
  actorContext: AuthorizedActionContext,
  scoped: ScopedThoughtContext,
): AudienceResolutionResult => {
  const explicitAudienceType = scoped.audienceType
  const visibilityAudienceType = scoped.visibility
    ? AUDIENCE_TYPE_BY_VISIBILITY[scoped.visibility]
    : undefined

  if (
    explicitAudienceType
    && visibilityAudienceType
    && explicitAudienceType !== visibilityAudienceType
  ) {
    return {
      error: 'audienceType and visibility must describe the same memory audience',
    }
  }

  const audienceType = explicitAudienceType
    ?? visibilityAudienceType
    ?? defaultCaptureAudienceType(actorContext, scoped)
  const audienceId = resolveAudienceId(audienceType, actorContext, scoped)

  if (!audienceId) {
    return {
      error: `Unable to resolve audience ID for ${audienceType} memory`,
    }
  }

  return {
    audience: {
      audienceType,
      audienceId,
      visibility: VISIBILITY_BY_AUDIENCE_TYPE[audienceType],
    },
  }
}

export const resolveThoughtOutputAudience = (
  actorContext: AuthorizedActionContext,
): AudienceResolutionResult => {
  if (actorContext.actor.actorType !== 'user') {
    return { error: 'User actor required to resolve memory output audience' }
  }

  const channelId = actorContext.actionContext.channelId ?? actorContext.tenant.channelId
  if (channelId) {
    return {
      audience: {
        audienceType: 'channel',
        audienceId: channelId,
        visibility: 'channel',
      },
    }
  }

  return {
    audience: {
      audienceType: 'user',
      audienceId: actorContext.actor.actorId,
      visibility: 'private',
    },
  }
}
