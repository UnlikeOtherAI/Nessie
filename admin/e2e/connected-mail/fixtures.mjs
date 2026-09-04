// Deterministic boundary fixtures for the connected-mail browser suite. They
// are HTTP responses, not a component fixture: the production router, shell,
// React Query facade and email components all run unchanged in Chromium.

const now = '2026-09-04T09:30:00.000Z'
const ids = {
  channel: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  team: '44444444-4444-4444-8444-444444444444',
  thread: '55555555-5555-4555-8555-555555555555',
  user: '66666666-6666-4666-8666-666666666666',
}

const envelope = (data) => ({ data })

export const createMailFixtures = () => {
  const calls = []
  const unhandled = []
  let doorwayAllowed = true
  let doorwayVisible = false

  const accounts = () => [
    {
      address: 'alex@example.com', canCompose: true, canRead: true,
      canSend: true, id: 'gmail-1', label: 'Alex work', scope: 'personal',
      source: 'gmail', status: 'active',
    },
    {
      address: 'inbox@team.example', canCompose: true, canRead: true,
      canSend: true, id: 'mailbox-1', label: 'Operations inbox', scope: 'shared',
      source: 'mailbox', status: 'active',
    },
  ].filter((account) => doorwayAllowed || account.id !== 'gmail-1')

  const conversation = {
    earlierMessagesMayExist: false,
    id: 'thread-1',
    messages: [
      {
        attachments: [], blockedRemoteContent: true,
        body: '<p>Hello from <strong>Acme</strong>.</p><img alt="remote logo" data-blocked-src="https://tracker.example/pixel.png">',
        bodyFormat: 'html', cc: [], from: 'Casey <casey@acme.example>',
        id: 'message-1', inReplyTo: null, receivedAt: now, subject: 'Launch checklist',
        threadId: 'thread-1', to: ['alex@example.com'],
      },
    ],
  }

  const threads = {
    estimate: 2,
    items: [
      {
        from: 'Casey <casey@acme.example>', hasAttachments: false, id: 'thread-1',
        messageCount: 1, receivedAt: now, snippet: 'Hello from Acme.',
        subject: 'Launch checklist', unread: true,
      },
      {
        from: 'Morgan <morgan@example.com>', hasAttachments: true, id: 'thread-2',
        messageCount: 2, receivedAt: '2026-09-03T09:30:00.000Z', snippet: 'Budget confirmed.',
        subject: 'Budget', unread: false,
      },
    ],
    nextCursor: 'next-page',
  }

  const me = {
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
    context: {
      bootstrapMode: false, channelId: null, organizationId: ids.organization,
      projectId: ids.project, teamId: ids.team,
    },
    session: { issuedAt: now, sessionId: '77777777-7777-4777-8777-777777777777' },
    user: { displayName: 'Alex Example', email: 'alex@example.com', id: ids.user, roleIds: ['owner'] },
  }

  const channel = {
    createdAt: now, defaultThreadId: ids.thread, id: ids.channel, label: 'Email triage',
    lastMessageAt: now, memberRole: 'owner', organizationId: ids.organization,
    projectId: ids.project, projectName: 'Launch', scope: 'project', slug: 'email-triage',
    teamId: ids.team, teamName: 'Delivery', type: 'standard', unreadCount: 0,
    updatedAt: now, visibility: 'private',
  }

  let doorway = { accountId: 'gmail-1', mode: 'thread', source: 'gmail', threadId: 'thread-1' }
  const doorwayMessage = {
    content: 'I found an email that needs your review.', createdAt: now,
    id: '88888888-8888-4888-8888-888888888888', role: 'assistant', threadId: ids.thread,
  }

  const shellResponse = (pathname) => {
    if (pathname === '/api/agents' || pathname === '/api/agents/all') return []
    if (pathname === '/api/channels') return [channel]
    if (pathname === '/api/projects' || pathname === '/api/teams' || pathname === '/api/users' || pathname === '/api/favorites') return []
    if (pathname === '/api/integrations/products') return []
    if (pathname === '/api/alerts/summary') return { assignedWork: { projects: {}, total: 0 }, knowledge: { projects: {}, total: 0 }, unreadCount: 0 }
    if (pathname === '/api/threads/activity') return { hasMore: false, items: [], unreadTotal: 0 }
    if (pathname === '/api/direct-messages/unread') return { items: [] }
    if (pathname === '/api/personal-assistant') return null
    if (pathname === '/api/alerts') return []
    if (pathname === '/api/events/stream') return null
    return undefined
  }

  const respond = async (route, request) => {
    const url = new URL(request.url())
    const method = request.method()
    const { pathname } = url
    calls.push({ method, pathname, search: url.search })
    const json = (data, status = 200) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify(envelope(data)), status,
    })

    if (pathname === '/api/auth/me') return json(me)
    if (pathname === '/api/auth/providers') return json([])
    if (pathname === '/api/organizations/current') return json(null)
    if (pathname === '/api/presence') return json([])
    if (pathname === '/api/presence/heartbeat' || pathname === '/api/push-surfaces/heartbeat') return json({})
    if (pathname === '/api/auth/me/preferences' && method === 'PATCH') return json(me)
    if (pathname.startsWith('/api/users/') && pathname.endsWith('/avatar')) return route.fulfill({ status: 204 })
    if (pathname === '/api/demonstrations') return json([])
    if (pathname.startsWith('/api/demonstrations/active/')) return json([])
    if (pathname === '/api/voice/capability') return json({ available: false })
    if (pathname === '/api/comms/connections') return json({ connections: [] })
    if (pathname.startsWith('/api/channels/') && pathname.endsWith('/call')) return json(null)
    if (pathname.startsWith('/api/messages/') && pathname.endsWith('/attachments')) return json([])
    if (pathname === '/api/events/stream') return route.fulfill({
      body: '', contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, status: 200,
    })
    if (pathname === '/api/mail/accounts') return json(accounts())
    if (pathname.endsWith('/threads') && pathname.startsWith('/api/mail/accounts/')) return json(threads)
    if (pathname.endsWith('/threads/thread-1') && pathname.startsWith('/api/mail/accounts/')) return json(conversation)
    if (pathname.endsWith('/threads/thread-2') && pathname.startsWith('/api/mail/accounts/')) return json({ ...conversation, id: 'thread-2' })
    if (pathname === '/api/gmail/drafts/draft-doorway') return json({
      bcc: [], body: 'Prepared response', cc: [], id: 'draft-doorway', subject: 'Prepared reply', to: ['casey@acme.example'],
    })
    if (pathname.startsWith('/api/gmail/drafts/') && pathname.endsWith('/undo') && method === 'POST') return json({ state: 'cancelled' })
    if (pathname.endsWith('/drafts') && pathname.startsWith('/api/mail/accounts/') && method === 'POST') return json({
      contentFingerprint: 'fingerprint-1', id: 'draft-created', status: 'draft',
    })
    if (pathname.includes('/drafts/') && pathname.startsWith('/api/mail/accounts/') && method === 'PATCH') return json({
      contentFingerprint: 'fingerprint-2', id: pathname.split('/').at(-1), status: 'draft',
    })
    if (pathname.endsWith('/send') && pathname.startsWith('/api/mail/accounts/') && method === 'POST') return json({
      id: pathname.includes('/gmail/') ? 'draft-created' : 'mailbox-sent',
      sendAfter: pathname.includes('/gmail/') ? '2026-09-04T09:30:30.000Z' : undefined,
      status: pathname.includes('/gmail/') ? 'held' : 'sent',
    })
    if (pathname === `/api/threads/${ids.thread}/messages`) return json(doorwayVisible
      ? [{ ...doorwayMessage, metadata: { mailSurfaceDoorway: doorway } }]
      : [])
    if (pathname === `/api/threads/${ids.thread}/thinking`) return json({ runs: [] })
    if (pathname === `/api/threads/${ids.thread}/document-streams`) return json([])
    if (pathname === `/api/threads/${ids.thread}/stream`) return route.fulfill({
      body: '', contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, status: 200,
    })
    if (pathname === `/api/threads/${ids.thread}/read` && method === 'POST') return json({})

    const shell = shellResponse(pathname)
    if (shell !== undefined) return json(shell)
    unhandled.push({ method, pathname, search: url.search })
    // Returning a successful empty boundary keeps React Query from emitting a
    // second, less useful console error; the runner fails with this exact list.
    return json({})
  }

  return {
    calls,
    ids,
    unhandled,
    respond,
    showDoorway: () => { doorwayVisible = true },
    showComposeDoorway: () => { doorway = { accountId: 'gmail-1', draftId: 'draft-doorway', mode: 'compose', source: 'gmail' } },
    denyDoorway: () => { doorwayAllowed = false },
    allowDoorway: () => { doorwayAllowed = true },
  }
}
