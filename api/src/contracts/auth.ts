import { AuthProviderResponseTypeSchema } from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema } from './shared.js'

export const SsoThemeSchema = z.enum([
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
])
export type SsoTheme = z.infer<typeof SsoThemeSchema>

export const AuthProviderDescriptorSchema = z.object({
  providerId: NonEmptyStringSchema,
  type: AuthProviderResponseTypeSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  autoRedirect: z.boolean(),
  url: z.string().url().optional(),
})
export type AuthProviderDescriptor = z.infer<typeof AuthProviderDescriptorSchema>

export const AuthProviderAuthorizeQuerySchema = z.object({
  codeChallenge: NonEmptyStringSchema,
  redirectUri: z.string().url(),
  state: NonEmptyStringSchema,
  theme: SsoThemeSchema.optional(),
  teamHint: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
})
export type AuthProviderAuthorizeQuery = z.infer<typeof AuthProviderAuthorizeQuerySchema>

export const SsoConfigQuerySchema = z.object({
  theme: SsoThemeSchema.optional(),
})

export const BootstrapModeResponseSchema = z.object({
  bootstrapMode: z.literal(true),
  bootstrapUrl: z.literal('/bootstrap'),
})

export const BootstrapRequestSchema = z.object({
  bootstrapToken: z.string().uuid(),
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
})

export const LoginRequestSchema = z.object({
  code: z.string().min(1).optional(),
  codeVerifier: z.string().min(1).optional(),
  email: z.string().email().optional(),
  // Strict discriminant for a team-switch reauthorization: the exact UOA
  // org/team the renewed session must land on. Valid ONLY as a complete
  // providerId=uoa code exchange accompanied by a current Bearer Nessie
  // session for the same immutable UOA subject — an unauthenticated caller has
  // no account to recover, so any missing/invalid/revoked/local-session use is
  // refused before the upstream exchange runs. Identity is the UOA subject,
  // never the exchanged email.
  expectedTeam: z.object({
    organizationId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256),
  }).optional(),
  password: z.string().min(1).optional(),
  providerId: NonEmptyStringSchema.optional(),
  redirectUri: z.string().url().optional(),
  theme: SsoThemeSchema.optional(),
})

// Change the signed-in user's local-account password. Only valid for accounts
// that have a password (SSO accounts have none and are rejected server-side).
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

export const UoaTeamSwitchRequestSchema = z.object({
  organizationId: z.string().trim().min(1).max(256),
  teamId: z.string().trim().min(1).max(256),
})

/**
 * Switch the signed-in session to a different organisation / project / team.
 *
 * The handler used to read this body as a raw cast and check the three fields
 * for truthiness, in a file whose other handler validates with a zod contract
 * (2026-09-05 review, F1-5). Ids are local database uuids, so a value that is
 * not one cannot name a row and is refused at the boundary rather than
 * reaching Prisma.
 */
export const SwitchContextBodySchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
})
export type SwitchContextBody = z.infer<typeof SwitchContextBodySchema>
