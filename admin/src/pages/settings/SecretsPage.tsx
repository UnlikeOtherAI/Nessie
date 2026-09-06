import { SecretsPanel } from './SecretsPanel'

/**
 * A person's own Secrets, and everything above them that reaches their work.
 * The team and organisation levels have their own pages
 * (`TeamSecretsPage`, `OrganizationSecretsPage`); all three are one component.
 */
export const SecretsPage = () => <SecretsPanel scope="personal" />
