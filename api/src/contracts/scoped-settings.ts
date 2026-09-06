import { z } from 'zod'

import { SETTING_SCOPES } from '@nessie/runtime'

export const SettingScopeSchema = z.enum(SETTING_SCOPES)

export const ResolvedSettingSchema = z.object({
  key: z.string(),
  /** The value in force at the level being viewed, or null when none is set. */
  value: z.unknown().nullable(),
  setAtScope: SettingScopeSchema.nullable(),
  /**
   * The level that stopped everything below it overriding, or null. A client
   * greys its control and names this level rather than accepting an edit the
   * server would refuse.
   */
  lockedAtScope: SettingScopeSchema.nullable(),
  /** Whether the level being viewed may still change this. */
  canEdit: z.boolean(),
  /** Whether this level currently holds the lock. */
  lockedHere: z.boolean(),
})

export const ResolvedSettingListSchema = z.object({
  settings: z.array(ResolvedSettingSchema),
})

export const WriteScopedSettingBodySchema = z
  .object({
    scope: SettingScopeSchema,
    /**
     * Nullable as well as optional: a caller that holds "the team, if any" in
     * one variable sends it as null at organisation and personal scope, and a
     * `.strict()` `.optional()` refused that with "Expected string, received
     * null" — which is how every press of the organisation's lock checkbox
     * failed, since the panel is one component for all three scopes.
     */
    teamId: z.string().uuid().nullish(),
    value: z.unknown().optional(),
    locked: z.boolean(),
  })
  .strict()
