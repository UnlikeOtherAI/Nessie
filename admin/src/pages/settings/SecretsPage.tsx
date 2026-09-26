import { SecretsPanel } from './SecretsPanel'

/**
 * Saved keys: a person's own keys, and everything above them that reaches
 * their work. The organisation's and each team's are Admin › Keys at that
 * scope; every level is one component.
 */
export const SecretsPage = () => <SecretsPanel scope="personal" />
