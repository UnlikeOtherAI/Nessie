/**
 * A scripted mail server for the connect ladder.
 *
 * The point of this suite is the escalation itself — what the form asks for
 * next after each refusal — so the API is intercepted rather than run: the
 * interesting states (one leg reachable and the other not, a rejected password,
 * a domain nothing can be discovered about) are all server verdicts, and
 * scripting them is the only way to walk the whole ladder in one pass.
 *
 * Every connect attempt is recorded, so the assertions can check the payload as
 * well as the screen: a form that silently posts a placeholder port would look
 * identical on screen and would disable the entire sweep.
 */

const envelope = (data) => ({ data })

const ids = {
  organization: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
}

const now = '2026-09-16T09:00:00.000Z'

/** Discovery that knows the domain exists and nothing else about it. */
const undiscoverable = (email) => ({
  authentication: { available: false, strategy: 'manual', unavailableReason: null },
  configurationConfidence: 0,
  credentialDestinationTrust: 0,
  domain: email.slice(email.lastIndexOf('@') + 1),
  email,
  evidence: [],
  fallbackConnectors: [],
  preferredConnector: { available: false, type: 'manual', unavailableReason: null },
  provider: 'generic',
  ui: {
    providerIcon: 'generic',
    providerName: 'Email',
    requiresAdvancedSettings: false,
    requiresManualSettings: true,
    requiresProviderConfirmation: false,
  },
})

export const createOnboardingFixtures = () => {
  const connectAttempts = []
  const unhandled = []
  /** Verdicts to serve, in order; the last one is reused if attempts run on. */
  let script = []

  const me = {
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
    context: {
      bootstrapMode: false,
      channelId: null,
      organizationId: ids.organization,
      projectId: ids.project,
      teamId: ids.team,
    },
    session: { issuedAt: now, sessionId: '77777777-7777-4777-8777-777777777777' },
    user: { displayName: 'Alex Example', email: 'alex@example.com', id: ids.user, roleIds: ['owner'] },
  }

  const empty = (pathname, method) => {
    if (pathname === '/api/agents' || pathname === '/api/agents/all') return []
    if (pathname === '/api/channels' || pathname === '/api/projects') return []
    if (pathname === '/api/teams' || pathname === '/api/users' || pathname === '/api/favorites') return []
    if (pathname === '/api/alerts') return []
    if (pathname === '/api/demonstrations') return []
    if (pathname === '/api/workflow-runs') return []
    if (pathname === '/api/alerts/summary') {
      return { assignedWork: { projects: {}, total: 0 }, knowledge: { projects: {}, total: 0 }, unreadCount: 0 }
    }
    if (pathname === '/api/threads/activity') return { hasMore: false, items: [], unreadTotal: 0 }
    if (pathname === '/api/direct-messages/unread') return { items: [] }
    if (pathname === '/api/approvals/pending/count') return { count: 0 }
    if (pathname === '/api/personal-assistant') return null
    // The Connections page renders several panels beside the mailbox one. They
    // are outside this suite's assertion boundary but not outside the page, and
    // a panel that crashes on a null list takes the dialog down with it — so
    // the default for an unrecognised read is an empty list, not null.
    if (method === 'GET' && pathname.startsWith('/api/')) return []
    return undefined
  }

  const respond = async (route, request) => {
    const url = new URL(request.url())
    const method = request.method()
    const { pathname } = url
    const json = (data, status = 200) => route.fulfill({
      body: JSON.stringify(envelope(data)),
      contentType: 'application/json',
      status,
    })

    if (pathname === '/api/auth/me') return json(me)
    if (pathname === '/api/auth/providers') return json([])
    if (pathname === '/api/organizations/current') return json(null)
    if (pathname === '/api/presence') return json([])
    if (pathname === '/api/presence/heartbeat' || pathname === '/api/push-surfaces/heartbeat') return json({})
    if (pathname === '/api/voice/capability') return json({ available: false })
    if (pathname === '/api/comms/connections') return json({ connections: [] })
    if (pathname === '/api/comms/providers') {
      // Neither OAuth route is registered on this server, so the address is the
      // only way through — which is the path this suite is about.
      return json({ providers: [
        { available: false, provider: 'google' },
        { available: false, provider: 'microsoft' },
      ] })
    }
    if (pathname === '/api/cloud-browser/connections') return json({ connections: [] })
    if (pathname === '/api/mailbox-connections' && method === 'GET') return json({ connections: [] })

    if (pathname === '/api/mailbox-connections/discover') {
      const body = JSON.parse(request.postData() ?? '{}')
      return json(undiscoverable(body.email ?? 'person@example.com'))
    }

    if (pathname === '/api/mailbox-connections' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}')
      connectAttempts.push(body)
      const verdict = script[connectAttempts.length - 1] ?? script.at(-1)
      if (!verdict || verdict.ok) {
        return json({
          address: body.address,
          agentIds: [],
          createdByUserId: ids.user,
          id: '55555555-5555-4555-8555-555555555555',
          imapHost: 'imap.example.com',
          imapPort: 993,
          imapSecurity: 'tls',
          label: body.label,
          lastVerifiedAt: now,
          ownerUserId: ids.user,
          scope: 'user',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpSecurity: 'starttls',
          status: 'active',
          statusReason: null,
          teamId: null,
          username: body.username ?? body.address,
        }, 201)
      }
      return route.fulfill({
        body: JSON.stringify({
          error: {
            code: verdict.code,
            details: verdict.diagnosis,
            message: verdict.message,
          },
        }),
        contentType: 'application/json',
        status: verdict.status ?? 400,
      })
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/avatar')) {
      return route.fulfill({ status: 204 })
    }
    if (pathname === '/api/auth/me/preferences' && method === 'PATCH') return json(me)

    const fallback = empty(pathname, method)
    if (fallback !== undefined) return json(fallback)
    if (pathname === '/api/events/stream') {
      return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 })
    }

    unhandled.push(`${method} ${pathname}`)
    return json(null)
  }

  return {
    connectAttempts,
    ids,
    respond,
    /** Queue the verdicts each successive connect attempt should receive. */
    scriptConnects: (verdicts) => { script = verdicts },
    unhandled,
  }
}

/** The refusal shapes the real service produces, restated for the script. */
export const verdicts = {
  bothLegsMissing: {
    code: 'SERVER_UNAVAILABLE',
    diagnosis: {
      imap: { failure: 'unreachable', ok: false },
      smtp: { failure: 'unreachable', ok: false },
    },
    message: 'We could not find a mail server for this address. Enter its settings to continue.',
    status: 503,
  },
  credentialRejected: {
    code: 'CREDENTIAL_REJECTED',
    diagnosis: {
      imap: { failure: 'credential_rejected', ok: false },
      smtp: { failure: 'credential_rejected', ok: false },
    },
    message: 'The email address or password was not accepted.',
    status: 400,
  },
  ok: { ok: true },
  smtpMissing: {
    code: 'SERVER_UNAVAILABLE',
    diagnosis: {
      imap: { host: 'mail.example.com', ok: true, port: 993 },
      smtp: { failure: 'unreachable', host: 'mail.example.com', ok: false, port: 587 },
    },
    message: 'We connected to your incoming mail (IMAP) server, but could not reach an '
      + 'outgoing mail (SMTP) server. Enter its settings to continue.',
    status: 503,
  },
}
