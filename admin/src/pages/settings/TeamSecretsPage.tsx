import { SecretsPanel } from './SecretsPanel'

/** A team's secrets, over the organisation's. Writing one is owner-gated. */
export const TeamSecretsPage = () => <SecretsPanel scope="team" />
