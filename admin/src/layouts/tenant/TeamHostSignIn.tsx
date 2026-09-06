import type { TenantOrganisation } from '../../facades/team/tenant-host'
import { TenantBrandFrame, TenantSignInButton } from './tenant-brand'

/**
 * What a team's address shows somebody who is not signed in.
 *
 * Without this the app fell through to the product's own marketing page, so a
 * customer's team address advertised Nessie to their people instead of letting
 * them in. On a tenant hostname the tenant is the brand.
 *
 * It names the organisation and the address, and nothing else. The team's name
 * is deliberately absent: `/api/hosts/team` is authenticated precisely so that
 * a guessable address cannot confirm which team sits behind it, and rendering
 * the name here for an anonymous visitor would give that away by the back door.
 * The hostname is already on their screen — they typed it — so repeating it
 * discloses nothing.
 */
export const TeamHostSignIn = ({
  organisation,
  signInOrigin,
}: {
  organisation: TenantOrganisation
  signInOrigin: string | null
}) => (
  <TenantBrandFrame organisation={organisation}>
    <TenantSignInButton signInOrigin={signInOrigin} />
  </TenantBrandFrame>
)
