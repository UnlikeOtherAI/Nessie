import { z } from 'zod'

import {
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const AuthProviderResponseTypeSchema = z.enum([
  'oidc',
  'saml',
  'uoa',
  'local-bootstrap',
  'custom',
])
export type AuthProviderResponseType = z.infer<typeof AuthProviderResponseTypeSchema>

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const HttpUrlSchema = z.string().url().refine(
  (value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  },
  { message: 'URL must use HTTP or HTTPS' },
)

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const PushQuietHoursSchema = z.object({
  start: TimeOfDaySchema,
  end: TimeOfDaySchema,
  timezone: z.string().min(1).refine(isIanaTimeZone, {
    message: 'Timezone must be a valid IANA time zone',
  }),
})
export type PushQuietHours = z.infer<typeof PushQuietHoursSchema>

// A structured, foreground destination. This is intentionally not a free-form
// URL: delivery can only suppress a notification for a concrete surface it
// already understands how to target.
export const PushSurfaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('channel'),
    channelId: ChannelIdSchema,
    // A channel can host more than one independent conversation. Presence must
    // identify the exact thread so one open conversation never hides a banner
    // or a native push for another.
    threadId: ThreadIdSchema,
    // `null` is the channel's top-level feed; a UUID is one message-level
    // reply conversation within that thread container.
    // Defaulting absent values keeps already-installed clients safe during the
    // server-first rollout: old feed heartbeats mean the main channel feed.
    rootMessageId: z.string().uuid().nullable().default(null),
  }),
  z.object({ kind: z.literal('ops_usage') }),
  z.object({ kind: z.literal('project_board'), projectId: ProjectIdSchema }),
  z.object({ kind: z.literal('knowledge_space'), spaceId: z.string().uuid() }),
])
export type PushSurface = z.infer<typeof PushSurfaceSchema>

export const UserPreferencesSchema = z.object({
  starred: z.array(z.object({
    type: z.enum(['channel', 'project', 'user']),
    id: z.string(),
  })).optional(),
  pushEnabled: z.boolean().optional(),
  // Focus is a deliberate, across-device pause: the client mutes in-app
  // attention cues while the worker withholds system push delivery.
  focusModeEnabled: z.boolean().optional(),
  // Per-event delivery controls default to enabled when absent so existing
  // users retain the current important-notifications behaviour.
  pushMessages: z.boolean().optional(),
  pushMentions: z.boolean().optional(),
  pushIncomingCalls: z.boolean().optional(),
  pushBudgetAlerts: z.boolean().optional(),
  // A scheduled task that stopped running. Its own switch rather than a share
  // of budget alerts: silencing spend warnings must not silence the discovery
  // that automation has died, which is a different question entirely.
  pushTriggerHealth: z.boolean().optional(),
  pushAssignedWork: z.boolean().optional(),
  pushPublishedKnowledge: z.boolean().optional(),
  // `null` clears quiet hours via the partial-merge PATCH; absent leaves them unchanged.
  pushQuietHours: PushQuietHoursSchema.nullish(),
  theme: z.enum([
    'nebula',
    'midnight',
    'daylight',
    'forest',
    'ocean',
    'sunset',
    'rose',
    'graphite',
    'sandstone',
    'contrast',
    'system',
  ]).optional(),
  fontScale: z.enum(['small', 'medium', 'large']).optional(),
})
export type UserPreferences = z.infer<typeof UserPreferencesSchema>

// Avatar precedence (resolved by the client): the UnlikeOtherAI-hosted picture
// (relayed at GET /api/users/:id/avatar, 404 for an unlinked user) comes first
// — UOA owns the profile — then `avatarAttachmentId` (a locally uploaded
// avatar, only reachable in deployments with no UOA), then `avatarUrl` (the
// provider/Google picture), then initials.
export const MeUserSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  avatarUrl: z.string().url().optional(),
  avatarAttachmentId: z.string().uuid().optional(),
  pronouns: z.string().optional(),
  roleIds: z.array(NonEmptyStringSchema),
  superAdmin: z.boolean().default(false),
  preferences: UserPreferencesSchema.optional(),
})
export type MeUser = z.infer<typeof MeUserSchema>

export const UpdatePreferencesSchema = UserPreferencesSchema

// Set or clear the signed-in user's local avatar. `null` clears it, reverting
// to the provider picture / initials. Refused for a UOA session, whose profile
// picture is owned by UOA and changed through the relay
// (PUT/DELETE /api/auth/me/avatar/uoa).
export const UpdateMyAvatarRequestSchema = z.object({
  avatarAttachmentId: z.string().uuid().nullable(),
})
export type UpdateMyAvatarRequest = z.infer<typeof UpdateMyAvatarRequestSchema>

export const MeSessionSchema = z.object({
  sessionId: NonEmptyStringSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
})
export type MeSession = z.infer<typeof MeSessionSchema>

// A native shell names itself when it creates or renews a session. Browser
// sessions deliberately remain null: their browser and device are derived
// from the user-agent at the presentation boundary.
export const SessionClientTypeSchema = z.enum([
  'native-desktop',
  'native-ios',
  'native-android',
  'native-mobile',
])
export type SessionClientType = z.infer<typeof SessionClientTypeSchema>

export const SessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  userAgent: z.string().nullable(),
  clientType: SessionClientTypeSchema.nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

export const MeContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  teamId: TeamIdSchema,
  channelId: ChannelIdSchema.nullish(),
  bootstrapMode: z.boolean(),
})
export type MeContext = z.infer<typeof MeContextSchema>

export const MeAuthSchema = z.object({
  providerId: NonEmptyStringSchema,
  providerType: AuthProviderResponseTypeSchema,
  autoRedirectToSso: z.boolean(),
})
export type MeAuth = z.infer<typeof MeAuthSchema>

export const MeMembershipSchema = z.object({
  organizationId: OrganizationIdSchema,
  organizationName: z.string().optional(),
  role: z.string(),
  projects: z.array(z.object({
    projectId: ProjectIdSchema,
    projectName: z.string().optional(),
    teams: z.array(z.object({
      teamId: TeamIdSchema,
      teamName: z.string().optional(),
    })),
  })),
})
export type MeMembership = z.infer<typeof MeMembershipSchema>

export const UoaTeamDirectoryEntrySchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  // The local team id is only present when this person belongs to the Nessie
  // environment that mirrors the UOA team. It authorizes the team
  // picker to use the membership-scoped company-avatar relay.
  avatarTeamId: TeamIdSchema.optional(),
  // Public UOA-hosted image for directory entries that have not yet been
  // materialized as local Nessie teams. UOA may return a root-relative value,
  // but the API always exposes it here as an absolute HTTP(S) URL.
  avatarImageUrl: HttpUrlSchema.optional(),
  label: z.string().min(1),
  orgName: z.string().min(1).optional(),
  active: z.boolean(),
})
export type UoaTeamDirectoryEntry = z.infer<typeof UoaTeamDirectoryEntrySchema>

export const UoaPendingTeamInviteSchema = z.object({
  inviteId: z.string().min(1),
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  invitedBy: z.string().min(1).optional(),
  expiresAt: TimestampSchema.optional(),
})
export type UoaPendingTeamInvite = z.infer<typeof UoaPendingTeamInviteSchema>

export const SetChannelMuteRequestSchema = z.object({
  muted: z.boolean(),
})
export type SetChannelMuteRequest = z.infer<typeof SetChannelMuteRequestSchema>

export const MeResponseSchema = z.object({
  user: MeUserSchema,
  session: MeSessionSchema,
  context: MeContextSchema,
  auth: MeAuthSchema,
  memberships: z.array(MeMembershipSchema).optional(),
  uoaTeams: z.array(UoaTeamDirectoryEntrySchema).optional(),
  // Present (including as []) only when this process has a verified UOA
  // directory response. A cold-cache local fallback has no invite knowledge.
  uoaPendingInvites: z.array(UoaPendingTeamInviteSchema).optional(),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

export const OrganizationSummarySchema = z.object({
  id: OrganizationIdSchema,
  name: z.string(),
  role: z.string(),
  logoAttachmentId: z.string().uuid().nullable(),
  stripImageMetadata: z.boolean(),
  // True when this organisation is bound to an UnlikeOtherAI organisation, so
  // its name is UOA's and a rename is relayed there rather than stored here.
  // The id itself is deliberately not exposed — the client needs the fact, not
  // the external identifier.
  nameManagedExternally: z.boolean(),
  // The Organization section is gated by a live UOA role/capability read for
  // UOA-bound tenants. An outage is explicit so the UI never calls it a denial.
  administration: z.object({
    status: z.enum(['allowed', 'forbidden', 'unavailable']),
  }),
})
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>

// Owners/admins set or clear the org's round logo. `null` clears it.
export const UpdateOrganizationLogoRequestSchema = z.object({
  logoAttachmentId: z.string().uuid().nullable(),
})
export type UpdateOrganizationLogoRequest = z.infer<typeof UpdateOrganizationLogoRequestSchema>

// Owners/admins update the org profile: rename, set/clear the logo, and/or
// toggle EXIF/GPS metadata stripping on image uploads (default on). Each field
// is optional so a name-only or logo-only PATCH leaves the others intact;
// at least one must be present.
export const UpdateOrganizationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    logoAttachmentId: z.string().uuid().nullable().optional(),
    stripImageMetadata: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.logoAttachmentId !== undefined ||
      body.stripImageMetadata !== undefined,
    {
      message: 'Provide a name, logoAttachmentId or stripImageMetadata to update',
    },
  )
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>

export const FeedbackRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  attachmentId: z.string().uuid().nullable(),
  attachmentFilename: z.string().nullable(),
  githubIssueNumber: z.number().int().nullable(),
  githubIssueUrl: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
})
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>

export const CreateFeedbackRequestSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  attachmentId: z.string().uuid().nullable().optional(),
})
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequestSchema>
