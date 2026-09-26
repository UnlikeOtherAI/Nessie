import {
  createUoaSubjectAssertion,
  type UoaDelegatedIdentitySettings,
  type UoaSubjectAssertionIdentity,
} from './uoa-delegated-identity.js'
import { requestUoaOrganization, type UoaOrgRequestDeps } from './uoa-org-request.js'

type InFlightReads = Map<string, Promise<unknown>>

const productionReads: InFlightReads = new Map()
// Injected transports (tests) each get their own table, so two fakes asked
// about the same subject never answer for each other.
const injectedReads = new WeakMap<object, InFlightReads>()

const readsFor = (deps: Omit<UoaOrgRequestDeps, 'subjectAssertion'>): InFlightReads => {
  const transport = deps.fetchImpl ?? deps.resolveHost
  if (!transport) return productionReads
  let reads = injectedReads.get(transport)
  if (!reads) {
    reads = new Map()
    injectedReads.set(transport, reads)
  }
  return reads
}

/**
 * One live `GET /org/me` for a UOA subject acting in one organisation and team.
 *
 * Every authenticated request, run dispatch and entitlement recheck asks UOA
 * this same question, and a single page load or event replay asks it dozens of
 * times in the same instant. Reads for the same subject, organisation, team and
 * credential epoch that start while one is already in flight share that read:
 * its answer (or refusal, or outage) is what each of them would have received.
 * Nothing outlives the read — a caller that arrives after it settles asks UOA
 * again, and a changed epoch is a different key. A caller that joins a read
 * already in flight receives the answer UOA gave when that read began, which
 * can be up to one UOA round trip older than its own arrival (bounded by the
 * request timeout in `uoa-org-request.ts`): revocation freshness degrades by
 * at most that window, never more.
 */
export const readUoaOrgMe = (
  settings: UoaDelegatedIdentitySettings,
  identity: UoaSubjectAssertionIdentity,
  deps: Omit<UoaOrgRequestDeps, 'subjectAssertion'> = {},
): Promise<unknown> => {
  const reads = readsFor(deps)
  const key = JSON.stringify([
    settings.authBaseUrl,
    settings.sourceDomain,
    settings.configUrl,
    identity.subject,
    identity.organizationId,
    identity.teamId,
    identity.tokenVersion,
  ])
  const inFlight = reads.get(key)
  if (inFlight) return inFlight

  const read = requestUoaOrganization(settings, '/org/me', { method: 'GET' }, {
    ...deps,
    subjectAssertion: createUoaSubjectAssertion(settings, identity, `${settings.authBaseUrl}/org`),
  }).finally(() => {
    reads.delete(key)
  })
  reads.set(key, read)
  return read
}
