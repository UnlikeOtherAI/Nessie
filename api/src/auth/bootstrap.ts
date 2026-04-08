import { randomUUID } from 'node:crypto'

const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000

export type BootstrapTokenState = {
  expiresAt: Date
  token: string
}

export const createBootstrapTokenState = (): BootstrapTokenState => ({
  token: randomUUID(),
  expiresAt: new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS),
})

export const isBootstrapTokenExpired = (state: BootstrapTokenState): boolean =>
  state.expiresAt.getTime() <= Date.now()
