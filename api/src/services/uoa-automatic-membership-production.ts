import { safeFetch } from '@nessie/runtime'
import { loadUoaSettings } from './uoa-auth.js'
import type { UoaAutomaticMembershipAdapter, UoaAutomaticMembershipOperation, UoaAutomaticMembershipTeam, UoaDomainSnapshotPage, UoaVerifiedDomainAttestation } from './uoa-automatic-membership.js'

const serviceKey = (): string | null => {
  const key = process.env.UOA_AUTOMATIC_MEMBERSHIP_APP_KEY?.trim()
  // This is the UOA billing application-key format. Keeping the exact prefix
  // here prevents an ordinary user/session token from accidentally enabling
  // a background membership authority.
  return key && key.startsWith('uoa_app_') ? key : null
}
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const fail = (message: string): never => { throw new Error(`[uoa automatic membership] ${message}`) }

/** A dedicated key is the only background credential; ordinary domain bearers never qualify. */
export const createProductionUoaAutomaticMembershipAdapter = (): UoaAutomaticMembershipAdapter | null => {
  if (process.env.NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED !== 'true') return null
  const key = serviceKey()
  if (!key) return null
  let settings: ReturnType<typeof loadUoaSettings>
  try { settings = loadUoaSettings() } catch { return null }
  if (!settings.baseUrl.startsWith('https://')) return null
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await safeFetch(new URL(path, settings.baseUrl), {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(10_000),
    }, { maxRedirects: 0 })
    if (!response.ok) fail(`endpoint returned ${response.status}`)
    return asRecord(await response.json())
  }
  const operation = (body: Record<string, unknown>): UoaAutomaticMembershipOperation => {
    const operationId = string(body.operation_id); const status = string(body.status)
    if (!operationId || !status || !['accepted', 'completed', 'already_member', 'failed'].includes(status)) fail('invalid operation response')
    return { operationId: operationId!, status: status! as UoaAutomaticMembershipOperation['status'] }
  }
  return {
    async attestVerifiedDomain(input): Promise<UoaVerifiedDomainAttestation | null> {
      const url = new URL('/org/automatic-membership/attestations', settings.baseUrl)
      const response = await safeFetch(url, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) }, { maxRedirects: 0 })
      if (response.status === 204) return null
      if (!response.ok) fail(`endpoint returned ${response.status}`)
      const body = asRecord(await response.json())
      const domain = string(body.domain); const uoaSub = string(body.subject); const assertedAt = string(body.asserted_at); const expiresAt = string(body.expires_at)
      if (!domain || !uoaSub || !assertedAt || !expiresAt || uoaSub !== input.uoaSub || domain !== input.domain) return null
      const asserted = new Date(assertedAt); const expires = new Date(expiresAt)
      return Number.isNaN(asserted.getTime()) || Number.isNaN(expires.getTime()) || expires <= new Date() ? null : { uoaSub, domain, assertedAt: asserted, expiresAt: expires }
    },
    async listTeams(input): Promise<readonly UoaAutomaticMembershipTeam[]> {
      const body = await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/teams`)
      return (Array.isArray(body.teams) ? body.teams : []).flatMap((item) => {
        const row = asRecord(item); const externalTeamId = string(row.team_id); const name = string(row.name)
        return externalTeamId && name ? [{ externalTeamId, name }] : []
      })
    },
    async assertRuleAdministrator(input): Promise<boolean> {
      const body = await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/authorizations`, { method: 'POST', body: JSON.stringify({ subject: input.uoaSub, team_ids: input.externalTeamIds }) })
      return body.allowed === true
    },
    async setRuleFence(input): Promise<void> {
      await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/rules/${encodeURIComponent(input.ruleId)}/fence`, { method: 'PUT', body: JSON.stringify({ generation: input.generation, fence_token: input.fenceToken, active: input.active }) })
    },
    async listVerifiedDomainSubjects(input): Promise<UoaDomainSnapshotPage> {
      const query = new URLSearchParams({ domain: input.domain, limit: String(input.limit) })
      if (input.cursor) query.set('cursor', input.cursor)
      if (input.snapshotId) query.set('snapshot_id', input.snapshotId)
      const body = await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/subjects?${query}`)
      const snapshotId = string(body.snapshot_id); const cursor = body.cursor === null ? null : string(body.cursor)
      const subjects = Array.isArray(body.subjects) ? body.subjects.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
      if (!snapshotId || (body.cursor !== null && !cursor)) fail('invalid snapshot page')
      return { snapshotId: snapshotId!, cursor, subjects }
    },
    async grantMember(input) {
      return operation(await request(`/org/automatic-membership/organisations/${encodeURIComponent(input.externalOrgId)}/teams/${encodeURIComponent(input.externalTeamId)}/grants`, { method: 'POST', body: JSON.stringify({ subject: input.uoaSub, domain: input.domain, idempotency_key: input.idempotencyKey, rule_id: input.ruleId, rule_generation: input.ruleGeneration, fence_token: input.fenceToken }) }))
    },
    async getOperation(input) { return operation(await request(`/org/automatic-membership/operations/${encodeURIComponent(input.operationId)}`)) },
  }
}
