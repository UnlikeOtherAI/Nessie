import { TriggerDetailPage } from '../../src/pages/TriggerDetailPage'
import { requestUrl } from '../support/request-url'

/**
 * The `page` scenario of the agent-triggers fixture: the real
 * `TriggerDetailPage` for a ticket trigger, signed in as `&viewer=` —
 * `owner` (an organisation owner who did not set it up: every control, and
 * the editor that warns before a save pauses machine access) or `author` (a
 * member who set it up: the page read-only, its Machine access section
 * working as usual). Only the session read goes through `fetch`; the fixture's
 * stubbed client answers everything else.
 */

const USER = { owner: '60000000-0000-4000-8000-000000000630', author: '60000000-0000-4000-8000-000000000620' }

export const installTriggerPageSession = (viewer: string) => {
  const owner = viewer !== 'author'
  const me = {
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local-bootstrap' as const },
    context: {
      bootstrapMode: false,
      organizationId: '60000000-0000-4000-8000-000000000010',
      projectId: '60000000-0000-4000-8000-000000000011',
      teamId: '60000000-0000-4000-8000-000000000010',
    },
    session: { issuedAt: '2026-09-23T09:00:00.000Z', sessionId: 'agent-triggers-e2e' },
    user: {
      displayName: owner ? 'Owner' : 'Ondrej',
      email: owner ? 'owner@example.test' : 'ondrej@example.test',
      id: owner ? USER.owner : USER.author,
      roleIds: [owner ? 'owner' : 'member'],
      superAdmin: false,
    },
  }
  window.localStorage.setItem('nessie.admin.token', 'agent-triggers-e2e')
  const passThrough = window.fetch.bind(window)
  window.fetch = async (input, init) =>
    new URL(requestUrl(input), window.location.origin).pathname === '/api/auth/me'
      ? Response.json({ data: me })
      : passThrough(input, init)
}

export const TriggerPageScenario = () => (
  <div className="h-screen">
    <TriggerDetailPage />
  </div>
)
