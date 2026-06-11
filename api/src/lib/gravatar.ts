import { createHash } from 'node:crypto'

// Gravatar identicon/photo URL for an email. We request `d=404` so that an email
// with no Gravatar returns a 404 — the client treats that as "no image" and falls
// back to initials, rather than receiving a generic placeholder. `s=160` keeps the
// payload small for the avatar sizes the admin renders.
export const buildGravatarUrl = (email: string): string => {
  const normalized = email.trim().toLowerCase()
  const hash = createHash('sha256').update(normalized).digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=160`
}
