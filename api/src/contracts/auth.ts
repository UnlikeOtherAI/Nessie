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
