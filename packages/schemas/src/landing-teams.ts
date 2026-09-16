import { z } from 'zod'

const HttpsOrHttpUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'https:' || url.protocol === 'http:')
        && !url.username
        && !url.password
    } catch {
      return false
    }
  },
  { message: 'Expected an http(s) URL without credentials' },
)

/**
 * One team on the public landing's "Your teams" section
 * (`GET /api/auth/landing-teams`).
 *
 * Deliberately only what the section draws: no ids, no email, no role. The
 * landing is a different origin from the app, and whatever this carries is
 * readable there, so anything not on screen stays out of the wire.
 */
export const LandingTeamSchema = z.object({
  label: z.string().min(1),
  orgName: z.string().min(1).optional(),
  avatarImageUrl: HttpsOrHttpUrlSchema.optional(),
  /** The team the person's session is on right now. */
  active: z.boolean(),
  /** Where pressing the entry goes: the team's own address, or the app. */
  href: HttpsOrHttpUrlSchema,
})
export type LandingTeam = z.infer<typeof LandingTeamSchema>

export const LandingTeamsResponseSchema = z.object({
  teams: z.array(LandingTeamSchema),
})
export type LandingTeamsResponse = z.infer<typeof LandingTeamsResponseSchema>
