import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type ChannelId,
  type OrganizationId,
  type ProjectId,
  type TeamId,
  type UserId,
} from '@nessie/schemas'

export const DEFAULT_BOOTSTRAP_RECORD_IDS = {
  organizationId: parseOrganizationId('00000000-0000-4000-8000-000000000001'),
  projectId: parseProjectId('00000000-0000-4000-8000-000000000002'),
  teamId: parseTeamId('00000000-0000-4000-8000-000000000003'),
  channelId: parseChannelId('00000000-0000-4000-8000-000000000004'),
} as const satisfies {
  channelId: ChannelId
  organizationId: OrganizationId
  projectId: ProjectId
  teamId: TeamId
}

export const DEFAULT_BOOTSTRAP_RECORD_NAMES = {
  channel: 'General',
  organization: 'Default Organization',
  project: 'Default Project',
  team: 'Default Team',
} as const

export type BootstrapUserSeedInput = {
  avatarUrl?: string
  displayName: string
  email: string
  passwordHash?: string
  pronouns?: string
  userId: string
}

export type BootstrapSeedPlan = {
  channel: {
    id: ChannelId
    label: string
    organizationId: OrganizationId
    projectId: ProjectId
    slug: string
    teamId: TeamId
    visibility: 'public'
  }
  channelMember: {
    channelId: ChannelId
    userId: UserId
  }
  organization: {
    id: OrganizationId
    name: string
  }
  organizationMember: {
    organizationId: OrganizationId
    role: 'owner'
    userId: UserId
  }
  project: {
    id: ProjectId
    name: string
    organizationId: OrganizationId
  }
  projectMember: {
    projectId: ProjectId
    role: 'owner'
    userId: UserId
  }
  team: {
    id: TeamId
    name: string
    projectId: ProjectId
  }
  teamMember: {
    role: 'owner'
    teamId: TeamId
    userId: UserId
  }
  user: {
    avatarUrl?: string
    displayName: string
    email: string
    id: UserId
    passwordHash?: string
    pronouns?: string
  }
}

export const createBootstrapSeedPlan = (
  input: BootstrapUserSeedInput,
): BootstrapSeedPlan => {
  const userId = parseUserId(input.userId)
  const { channelId, organizationId, projectId, teamId } = DEFAULT_BOOTSTRAP_RECORD_IDS

  return {
    organization: {
      id: organizationId,
      name: DEFAULT_BOOTSTRAP_RECORD_NAMES.organization,
    },
    organizationMember: {
      organizationId,
      role: 'owner',
      userId,
    },
    project: {
      id: projectId,
      name: DEFAULT_BOOTSTRAP_RECORD_NAMES.project,
      organizationId,
    },
    projectMember: {
      projectId,
      role: 'owner',
      userId,
    },
    team: {
      id: teamId,
      name: DEFAULT_BOOTSTRAP_RECORD_NAMES.team,
      projectId,
    },
    teamMember: {
      role: 'owner',
      teamId,
      userId,
    },
    channel: {
      id: channelId,
      label: DEFAULT_BOOTSTRAP_RECORD_NAMES.channel,
      organizationId,
      projectId,
      slug: 'general',
      teamId,
      visibility: 'public',
    },
    channelMember: {
      channelId,
      userId,
    },
    user: {
      id: userId,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      avatarUrl: input.avatarUrl,
      pronouns: input.pronouns,
    },
  }
}
