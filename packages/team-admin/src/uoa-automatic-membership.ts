import { safeFetch } from '@nessie/runtime'
import { loadUoaSettings } from './uoa-settings.js'

export type UoaVerifiedDomainAttestation = { uoaSub: string; domain: string; assertedAt: Date; expiresAt: Date }
export type UoaAutomaticMembershipTeam = { externalTeamId: string; name: string }
export type UoaDomainSnapshotPage = { snapshotId: string; subjects: readonly string[]; cursor: string | null }
export type UoaAutomaticMembershipOperation = { operationId: string; status: 'accepted' | 'completed' | 'already_member' | 'failed' }
export interface UoaAutomaticMembershipAdapter {
  attestVerifiedDomain(input: { uoaSub: string; domain: string }): Promise<UoaVerifiedDomainAttestation | null>
  listTeams(input: { externalOrgId: string }): Promise<readonly UoaAutomaticMembershipTeam[]>
  assertRuleAdministrator(input: { externalOrgId: string; externalTeamIds: readonly string[]; uoaSub: string }): Promise<boolean>
  setRuleFence(input: { externalOrgId: string; ruleId: string; generation: number; fenceToken: string; active: boolean }): Promise<void>
  listVerifiedDomainSubjects(input: { externalOrgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number }): Promise<UoaDomainSnapshotPage>
  grantMember(input: { externalOrgId: string; externalTeamId: string; uoaSub: string; domain: string; idempotencyKey: string; ruleId: string; ruleGeneration: number; fenceToken: string }): Promise<UoaAutomaticMembershipOperation>
  getOperation(input: { operationId: string }): Promise<UoaAutomaticMembershipOperation>
}

const key = (): string | null => {
  const value = process.env.UOA_AUTOMATIC_MEMBERSHIP_APP_KEY?.trim()
  return value?.startsWith('uak_') ? value : null
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const invalid = (message: string): never => { throw new Error(`[uoa automatic membership] ${message}`) }

/** Shared HTTP client for API and standalone worker; it fails closed without HTTPS and the dedicated UOA key. */
export const createProductionUoaAutomaticMembershipAdapter = (): UoaAutomaticMembershipAdapter | null => {
  if (process.env.NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED !== 'true') return null
  const appKey = key()
  if (!appKey) return null
  let settings: ReturnType<typeof loadUoaSettings>
  try { settings = loadUoaSettings() } catch { return null }
  if (!settings.baseUrl.startsWith('https://')) return null
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await safeFetch(new URL(path, settings.baseUrl), { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${appKey}`, 'Content-Type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(10_000) }, { maxRedirects: 0 })
    if (!response.ok) invalid(`endpoint returned ${response.status}`)
    return record(await response.json())
  }
  const operation = (body: Record<string, unknown>): UoaAutomaticMembershipOperation => {
    const operationId = text(body.operation_id); const status = text(body.status)
    if (!operationId || !status || !['accepted', 'completed', 'already_member', 'failed'].includes(status)) invalid('invalid operation response')
    return { operationId: operationId!, status: status! as UoaAutomaticMembershipOperation['status'] }
  }
  return {
    async attestVerifiedDomain(input) {
      const response = await safeFetch(new URL('/org/automatic-membership/attestations', settings.baseUrl), { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${appKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) }, { maxRedirects: 0 })
      if (response.status === 204) return null
      if (!response.ok) invalid(`endpoint returned ${response.status}`)
      const body = record(await response.json()); const domain = text(body.domain); const uoaSub = text(body.subject); const assertedAt = text(body.asserted_at); const expiresAt = text(body.expires_at)
      if (!domain || !uoaSub || !assertedAt || !expiresAt || domain !== input.domain || uoaSub !== input.uoaSub) return null
      const asserted = new Date(assertedAt); const expires = new Date(expiresAt)
      return Number.isNaN(asserted.getTime()) || Number.isNaN(expires.getTime()) || expires <= new Date() ? null : { uoaSub, domain, assertedAt: asserted, expiresAt: expires }
    },
    async listTeams(input) { const body = await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/teams`); return (Array.isArray(body.teams) ? body.teams : []).flatMap((value) => { const row = record(value); const externalTeamId = text(row.team_id); const name = text(row.name); return externalTeamId && name ? [{ externalTeamId, name }] : [] }) },
    async assertRuleAdministrator(input) { return (await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/authorizations`, { method: 'POST', body: JSON.stringify({ subject: input.uoaSub, team_ids: input.externalTeamIds }) })).allowed === true },
    async setRuleFence(input) { await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/rules/${encodeURIComponent(input.ruleId)}/fence`, { method: 'PUT', body: JSON.stringify({ generation: input.generation, fence_token: input.fenceToken, active: input.active }) }) },
    async listVerifiedDomainSubjects(input) { const query = new URLSearchParams({ domain: input.domain, limit: String(input.limit) }); if (input.cursor) query.set('cursor', input.cursor); if (input.snapshotId) query.set('snapshot_id', input.snapshotId); const body = await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/subjects?${query}`); const snapshotId = text(body.snapshot_id); const cursor = body.cursor === null ? null : text(body.cursor); const subjects = Array.isArray(body.subjects) ? body.subjects.filter((value): value is string => typeof value === 'string' && value.length > 0) : []; if (!snapshotId || (body.cursor !== null && !cursor)) invalid('invalid snapshot page'); return { snapshotId: snapshotId!, cursor, subjects } },
    async grantMember(input) { return operation(await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/teams/${encodeURIComponent(input.externalTeamId)}/grants`, { method: 'POST', body: JSON.stringify({ subject: input.uoaSub, domain: input.domain, idempotency_key: input.idempotencyKey, rule_id: input.ruleId, rule_generation: input.ruleGeneration, fence_token: input.fenceToken }) })) },
    async getOperation(input) { return operation(await request(`/org/automatic-membership/operations/${encodeURIComponent(input.operationId)}`)) },
  }
}
