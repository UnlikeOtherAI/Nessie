export type ExternalAuthIdentity = {
  avatarUrl?: string
  displayName: string
  email: string
}

// Derive a human-friendly display name from an email's local part, e.g.
// "ondrej.rafaj@gmail.com" -> "Ondrej Rafaj".
export const humanizeEmailLocalPart = (email: string): string => {
  const localPart = email.split('@')[0] ?? email
  const words = localPart
    .split(/[._+-]+/)
    .map((part) => part.replace(/\d+/g, '').trim())
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  return words.join(' ') || email
}

export const resolveIdentityDisplayName = (
  email: string,
  candidates: Array<string | undefined>,
): string => {
  const normalizedEmail = email.trim().toLowerCase()
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const providerName = candidates
    .map((candidate) => candidate?.trim() ?? '')
    .find(
      (candidate) =>
        candidate.length > 0 &&
        candidate.toLowerCase() !== normalizedEmail &&
        !emailLike.test(candidate),
    )

  return providerName ?? humanizeEmailLocalPart(normalizedEmail)
}
