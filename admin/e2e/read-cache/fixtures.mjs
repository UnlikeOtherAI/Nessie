// The real app, with only its HTTP boundary controlled to expose loading states.
const uuid = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
export const ids = { org: uuid(1), project: uuid(2), team: uuid(3), user: uuid(4), board: uuid(5) }
const timestamp = '2026-09-26T08:00:00.000Z'
const board = {
  id: ids.board, projectId: ids.project, name: 'Delivery board', iconEmoji: null,
  style: 'kanban', isDefault: true, position: 0, filter: { sources: 'all' },
  columns: [{ id: uuid(6), boardId: ids.board, name: 'To do', category: 'todo', position: 0, stateBindings: [] }],
}
const task = {
  id: uuid(7), organizationId: ids.org, projectId: ids.project, boardId: ids.board,
  iterationId: null, storyPoints: null, fieldValues: {}, externalLink: null,
  agentId: null, parentTaskId: null, runId: null, status: 'inbox', priority: 'medium',
  dueDate: null, archivedAt: null, title: 'Saved delivery ticket', purpose: null, detail: null,
  assigneeUserId: null, assigneeAgentId: null, assigneeName: null, ownerUserId: ids.user,
  ownerName: 'Reader', createdByUserId: ids.user, labels: [], commentCount: 0, attachmentCount: 0,
  viewerCanEdit: true, createdAt: timestamp, updatedAt: timestamp, columnId: uuid(6), position: 0,
}
export const channels = [8, 9].map((n) => ({
  id: uuid(n), defaultThreadId: uuid(n + 10), label: n === 8 ? 'General' : 'Planning', slug: `room-${n}`,
  type: 'standard', visibility: 'public', organizationId: ids.org, projectId: ids.project,
  projectName: 'Delivery', teamId: ids.team, teamName: 'Team', scope: 'project',
  viewerCanManage: true, viewerCanManageAgents: true, viewerIsMember: true,
  unreadCount: 0, lastMessageAt: null, createdAt: timestamp, updatedAt: timestamp,
}))

export const createReadCacheFixtures = () => {
  let release
  let barrier = null
  let userId = ids.user
  let revision = 0
  let denied = false
  const calls = []
  const pending = []
  const me = () => ({
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
    context: { bootstrapMode: false, organizationId: ids.org, projectId: ids.project, teamId: ids.team },
    session: { issuedAt: timestamp, sessionId: uuid(100) },
    user: { id: userId, displayName: 'Reader', email: 'reader@example.test', roleIds: ['owner'], superAdmin: false },
  })
  const respond = async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    calls.push(path)
    const json = (data) => route.fulfill({ json: { data } })
    if (path === '/api/auth/me' || path === '/api/auth/me/preferences') return json(me())
    if (path === '/api/auth/providers') return json([])
    if (path.endsWith('/stream')) return route.fulfill({ body: '', contentType: 'text/event-stream' })
    if (barrier && (path === '/api/projects' || path === '/api/teams' || path === '/api/channels'
      || path.includes('/boards') || path.endsWith('/messages'))) {
      pending.push(path)
      await barrier
    }
    if (path === '/api/projects') return json([{
      id: ids.project, organizationId: ids.org, name: 'Delivery', avatarEmoji: null,
      avatarAttachmentId: null, memberCount: 1, channelCount: 2, teamCount: 1, createdAt: timestamp,
    }])
    if (path === '/api/teams') return json([{
      id: ids.team, name: 'Team', projectId: ids.project, projectIds: [ids.project], memberCount: 1, createdAt: timestamp,
    }])
    if (path === '/api/channels') return json(channels)
    if (path === `/api/projects/${ids.project}/boards`) return json([board])
    if (path.endsWith('/tasks') && path.includes('/boards/')) {
      if (denied) return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Access removed' } } })
      return json({ tasks: [{ ...task, title: revision ? 'Updated delivery ticket' : task.title }], truncated: false })
    }
    if (path.endsWith('/ticket-work')) return json({ cards: [], pickups: [], viewerCanCreateTriggers: false })
    if (path.endsWith('/messages')) {
      const channel = channels.find((item) => path.includes(item.defaultThreadId))
      return route.fulfill({ json: { data: [{
        id: uuid(channel === channels[0] ? 30 : 31), threadId: channel.defaultThreadId,
        role: 'user', userId: ids.user, content: `${channel.label} saved message`, createdAt: timestamp,
        reactions: [], agentId: null, rootMessageId: null,
      }], meta: { hasMore: false, nextCursor: null, prevCursor: null } } })
    }
    if (path === '/api/alerts/summary') return json({
      assignedWork: { projects: {}, total: 0 }, knowledge: { projects: {}, total: 0 }, unreadCount: 0,
    })
    if (path === '/api/threads/activity') return json({ hasMore: false, items: [], unreadTotal: 0 })
    if (path === '/api/direct-messages/unread') return json({ items: [] })
    if (path === '/api/personal-assistant' || path === '/api/organizations/current') return json(null)
    if (path === '/api/voice/capability') return json({ available: false })
    if (path === '/api/users') return json([{ ...me().user, createdAt: timestamp, channelIds: channels.map((c) => c.id) }])
    if (path.endsWith('/heartbeat') || path.endsWith('/read') || path.endsWith('/clear')) return json({})
    if (path.endsWith('/avatar')) return route.fulfill({ status: 204 })
    return json([])
  }
  return {
    calls, pending, respond,
    hold: () => { pending.length = 0; barrier = new Promise((done) => { release = done }) },
    release: () => { barrier = null; release?.() },
    update: () => { revision += 1 },
    deny: () => { denied = true },
    switchUser: () => { userId = uuid(99) },
  }
}
