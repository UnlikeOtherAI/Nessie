import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * The local `User.displayName` / `User.avatarUrl` columns are a
 * **non-authoritative mirror** of the identity provider's profile, kept only so
 * a name and a picture can be rendered without a round trip per message row.
 * UOA owns the profile; Nessie never invents one and never writes one back from
 * a Nessie-side edit.
 *
 * Historically the mirror was captured once at provisioning and never refreshed
 * — a rename in UOA never arrived — and `/api/auth/me` papered over that by
 * manufacturing a name from the email local part on every call. Both are gone.
 * Instead every exchange that produces verified provider claims re-syncs the
 * mirror through this one function: SSO login and team-switch
 * materialization (via `ensureTeamPrincipal`) and ordinary session refresh
 * (via the UOA refresh coordinator).
 *
 * Only fields the provider actually asserted are written, and only when they
 * differ, so a provider that carries no name/picture claim leaves the mirror
 * exactly as it was rather than blanking it.
 */

export type ProfileMirrorClaims = {
  avatarUrl?: string
  displayName?: string
}

type ProfileMirrorClient = Pick<PrismaClient, 'user'> | Prisma.TransactionClient

export const syncProfileMirrorFromClaims = async (
  client: ProfileMirrorClient,
  userId: string,
  claims: ProfileMirrorClaims,
): Promise<void> => {
  const displayName = claims.displayName?.trim() || undefined
  const avatarUrl = claims.avatarUrl?.trim() || undefined
  if (!displayName && !avatarUrl) {
    return
  }

  const current = await client.user.findUnique({
    where: { id: userId },
    select: { avatarUrl: true, displayName: true },
  })
  if (!current) {
    return
  }

  const data: { avatarUrl?: string; displayName?: string } = {}
  if (displayName && displayName !== current.displayName) {
    data.displayName = displayName
  }
  if (avatarUrl && avatarUrl !== current.avatarUrl) {
    data.avatarUrl = avatarUrl
  }
  if (Object.keys(data).length === 0) {
    return
  }

  await client.user.update({ where: { id: userId }, data })
}

/**
 * Drop the mirrored picture after the person changed it at UOA through Nessie
 * (`PUT/DELETE /api/auth/me/avatar/uoa`).
 *
 * The relay writes the picture upstream and gets no URL back, so there is
 * nothing to mirror — and the URL still held locally is now the *previous*
 * picture. "Relay, then mirror from UOA's echo" is the rule the team and
 * organisation renames follow; this is its degenerate case, and skipping it
 * left every reader of `User.avatarUrl` showing the pre-upload image until the
 * next login or rotation (2026-09-05 review, FO2-7). Clearing is safe: the
 * client precedence falls through to the live UOA relay, and the next verified
 * claim re-syncs the mirror.
 */
export const clearProfileAvatarMirror = async (
  client: ProfileMirrorClient,
  userId: string,
): Promise<void> => {
  await client.user.updateMany({
    where: { id: userId, avatarUrl: { not: null } },
    data: { avatarUrl: null },
  })
}
