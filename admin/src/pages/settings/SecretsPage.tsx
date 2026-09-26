import { SecretsPanel } from './SecretsPanel'

/**
 * Saved keys: a person's own keys, and everything above them that reaches
 * their work. The organisation's are Admin › Keys and a team's are its page's
 * Keys tab; all three are one component.
 */
export const SecretsPage = () => <SecretsPanel scope="personal" />
