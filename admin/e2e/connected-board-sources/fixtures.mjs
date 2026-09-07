// HTTP boundary fixture for the connected-source UI. It deliberately uses the
// real router and React Query facades, while provider sync itself stays an API
// contract concern. The names make an accidental KiloMayo fixture impossible.

const now = '2026-09-07T09:30:00.000Z'

export const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  board: '22222222-2222-4222-8222-222222222222',
  column: '33333333-3333-4333-8333-333333333333',
  connection: '44444444-4444-4444-8444-444444444444',
  organization: '55555555-5555-4555-8555-855555555555',
  project: '66666666-6666-4666-8666-866666666666',
  source: '77777777-7777-4777-8777-877777777777',
  user: '88888888-8888-4888-8888-888888888888',
}

const envelope = (data) => ({ data })

export const createConnectedBoardSourceFixtures = () => {
  const calls = []
  const unhandled = []
  let holdMapping = false
  let pendingMapping = null

  const project = {
    avatarAttachmentId: null, avatarEmoji: null, channelCount: 0, createdAt: now,
    id: ids.project, memberCount: 1, name: 'UnlikeOtherAI QA', organizationId: ids.organization,
    teamCount: 0,
  }
  const board = {
    columns: [{ boardId: ids.board, category: 'todo', id: ids.column, name: 'To do', position: 0, stateBindings: [] }],
    filter: { sources: 'all' }, iconEmoji: null, id: ids.board, isDefault: true,
    name: 'UnlikeOtherAI QA board', position: 0, projectId: ids.project, style: 'kanban',
  }
  const source = {
    connectionId: ids.connection, connectionOwnerDisplayName: 'Alex Example', connectionOwnerUserId: ids.user,
    container: { id: 'linear-unlikeotherai-qa', name: 'UnlikeOtherAI QA' }, containerKey: 'linear-unlikeotherai-qa',
    healthDetail: null, healthReason: null, healthState: 'active', id: ids.source, itemCount: 4,
    lastErrorCode: null, lastSyncCompletedAt: now, lastSyncStartedAt: null, name: 'UnlikeOtherAI QA',
    pollingIntervalMinutes: 5, projectId: ids.project, provider: 'linear', syncWindowDays: 30,
    webhookActive: false, writeMode: 'read_write',
    stateMapping: [
      { category: 'todo', externalStateId: 'triage', externalStateName: 'Triage', isDefaultForCategory: true },
      { category: 'in_progress', externalStateId: 'started', externalStateName: 'Started', isDefaultForCategory: true },
    ],
  }
  const detail = {
    ...source,
    fieldMappings: [{ externalKey: 'priority', externalLabel: 'Priority', target: 'native:priority' }],
    fields: [{ key: 'priority', label: 'Priority', type: 'select' }],
    identityLinks: [
      { agentId: null, externalDisplayName: 'Alex Linear', externalUserId: 'linear-alex', id: '99999999-9999-4999-8999-999999999999', matchedBy: 'email', userId: ids.user },
      { agentId: ids.agent, externalDisplayName: 'Triage runner', externalUserId: 'linear-agent', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', matchedBy: 'manual', userId: null },
    ],
    members: [
      { displayName: 'Alex Linear', email: 'alex@example.test', externalUserId: 'linear-alex' },
      { displayName: 'Triage runner', externalUserId: 'linear-agent' },
    ],
    states: [{ id: 'triage', name: 'Triage' }, { id: 'started', name: 'Started' }],
  }
  const me = {
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
    context: { bootstrapMode: false, channelId: null, organizationId: ids.organization, projectId: ids.project, teamId: null },
    session: { issuedAt: now, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    user: { displayName: 'Alex Example', email: 'alex@example.test', id: ids.user, roleIds: ['owner'] },
  }

  const shell = (pathname) => {
    if (pathname === '/api/agents' || pathname === '/api/agents/all') return []
    if (pathname === '/api/channels' || pathname === '/api/teams' || pathname === '/api/users' || pathname === '/api/favorites') return []
    if (pathname === '/api/integrations/products') return []
    if (pathname === '/api/alerts/summary') return { assignedWork: { projects: {}, total: 0 }, knowledge: { projects: {}, total: 0 }, unreadCount: 0 }
    if (pathname === '/api/threads/activity') return { hasMore: false, items: [], unreadTotal: 0 }
    if (pathname === '/api/workflow-runs') return []
    if (pathname === '/api/direct-messages/unread') return { items: [] }
    if (pathname === '/api/personal-assistant') return null
    if (pathname === '/api/alerts' || pathname === '/api/presence') return []
    return undefined
  }

  const respond = async (route, request) => {
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()
    calls.push({ method, pathname, search: url.search })
    const json = (data, status = 200) => route.fulfill({
      body: JSON.stringify(envelope(data)), contentType: 'application/json', status,
    })
    const shellResponse = shell(pathname)

    if (pathname === '/api/auth/me') return json(me)
    if (pathname === '/api/auth/providers') return json([])
    if (pathname === '/api/organizations/current') return json(null)
    if (pathname === '/api/presence/heartbeat' || pathname === '/api/push-surfaces/heartbeat') return json({})
    if (pathname === '/api/auth/me/preferences' && method === 'PATCH') return json(me)
    if (pathname === '/api/events/stream') return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 })
    if (pathname.startsWith('/api/users/') && pathname.endsWith('/avatar')) return route.fulfill({ status: 204 })
    if (shellResponse !== undefined) return json(shellResponse)
    if (pathname === '/api/projects') return json([project])
    if (pathname === `/api/projects/${ids.project}/members`) return json([])
    if (pathname === `/api/projects/${ids.project}/boards`) return json([board])
    if (pathname === `/api/projects/${ids.project}/boards/${ids.board}/tasks`) return json({ tasks: [], truncated: false })
    if (pathname === `/api/projects/${ids.project}/sources`) return json([source])
    if (pathname === `/api/projects/${ids.project}/sources/${ids.source}`) return json(detail)
    if (pathname === '/api/board-sources/providers') return json([])
    if (pathname === '/api/board-sources/connections') return json([])
    if (pathname === `/api/projects/${ids.project}/fields`) return json([])
    if (pathname === '/api/tasks/assignees') return json([{ displayName: 'Alex Example', id: ids.user }])
    if (pathname === `/api/projects/${ids.project}/sources/${ids.source}/sync` && method === 'POST') return json({ ok: true })
    if (pathname === `/api/projects/${ids.project}/sources/${ids.source}/mappings` && method === 'PUT') {
      const body = request.postDataJSON()
      calls.at(-1).body = body
      if (!holdMapping) return json(source)
      holdMapping = false
      await new Promise((resolve) => { pendingMapping = { reject: resolve } })
      return route.fulfill({
        body: JSON.stringify({ error: { code: 'CONFLICT', message: 'UnlikeOtherAI QA rejected this mapping.' } }),
        contentType: 'application/json', status: 409,
      })
    }
    unhandled.push({ method, pathname, search: url.search })
    return route.fulfill({ body: JSON.stringify({ error: { message: `Unhandled fixture route: ${method} ${pathname}` } }), contentType: 'application/json', status: 500 })
  }

  return {
    calls,
    detail,
    holdNextMapping: () => { holdMapping = true },
    rejectHeldMapping: async () => {
      if (!pendingMapping) throw new Error('mapping request was not pending')
      pendingMapping.reject()
      pendingMapping = null
    },
    respond,
    unhandled,
  }
}
