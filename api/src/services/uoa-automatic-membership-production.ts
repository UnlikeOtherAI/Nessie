import type { UoaAutomaticMembershipAdapter } from './uoa-automatic-membership.js'

/**
 * Nessie has no documented UOA endpoint for this contract yet. Returning null
 * is intentional: ordinary UOA credentials must never be reinterpreted as a
 * backend membership grant credential. Tests inject the contract explicitly.
 */
export const createProductionUoaAutomaticMembershipAdapter = (): UoaAutomaticMembershipAdapter | null => null
