import { z } from 'zod'

export const UoaControlActionSchema = z.enum([
  'list', 'teams', 'create', 'update', 'verify', 'rotate', 'activate',
  'suspend', 'revoke', 'release',
])
export type UoaControlAction = z.infer<typeof UoaControlActionSchema>
export type UoaControlScope = 'organisation' | 'team'
export type UoaControlRuleAction = 'verify' | 'rotate' | 'activate' | 'suspend' | 'revoke'

const ExternalIdSchema = z.string().trim().min(1).max(200)
export const UoaControlPayloadSchemas = {
  list: z.object({}).strict(),
  teams: z.object({}).strict(),
  create: z.object({
    domain: z.string().trim().min(1).max(253),
    notification_email: z.string().trim().email().max(320).nullable().optional(),
    team_ids: z.array(ExternalIdSchema).min(1).max(100).optional(),
  }).strict(),
  update: z.object({
    rule_id: z.string().uuid(),
    notification_email: z.string().trim().email().max(320).nullable().optional(),
    team_ids: z.array(ExternalIdSchema).min(1).max(100).optional(),
  }).strict(),
  verify: z.object({ rule_id: z.string().uuid() }).strict(),
  rotate: z.object({ rule_id: z.string().uuid() }).strict(),
  activate: z.object({ rule_id: z.string().uuid() }).strict(),
  suspend: z.object({ rule_id: z.string().uuid() }).strict(),
  revoke: z.object({ rule_id: z.string().uuid() }).strict(),
  release: z.object({ rule_id: z.string().uuid() }).strict(),
} as const

export const isUoaControlRuleAction = (action: UoaControlAction): action is UoaControlRuleAction =>
  ['verify', 'rotate', 'activate', 'suspend', 'revoke'].includes(action)

export const isUoaControlActionAllowed = (action: UoaControlAction, scope: UoaControlScope): boolean =>
  action !== 'teams' || scope === 'organisation'

/** Exact stable external ids only; a local row never grants a cross-org mapping. */
export const hasExactUoaTeamBindings = (
  requestedExternalTeamIds: readonly string[],
  boundExternalTeamIds: readonly (string | null)[],
): boolean => {
  const requested = new Set(requestedExternalTeamIds)
  const bound = new Set(boundExternalTeamIds.filter((id): id is string => id !== null))
  return requested.size === requestedExternalTeamIds.length
    && requested.size === bound.size
    && [...requested].every((id) => bound.has(id))
}
