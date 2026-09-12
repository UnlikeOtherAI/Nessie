// The team the cases navigate: one organisation, one project and at
// least two channels a phone list can push into. Everything is created
// through the same REST routes a person's clicks call — there is no second
// seeding path to drift from them.
import { API_URL } from './config.mjs'
import { readBootstrapToken } from './servers.mjs'
import { PrismaClient } from '@prisma/client'

const CHANNEL_LABELS = ['Design Review', 'Release Notes']
const ISOLATED_BROWSER_PUSH_USER = {
  displayName: 'Browser Push E2E',
  email: 'navigation-browser-push@example.com',
  password: 'navigation-browser-push-password',
}

const request = async (path, { body, method = 'GET', token } = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
  }
  return payload
}

export const call = async (path, options) => (await request(path, options))?.data

// Two ways in, both already in the product: the one-time owner bootstrap on
// a fresh database, and the localhost-only dev-login on a database that
// already has an owner (a developer's own dev database).
const signIn = async (apiServer) => {
  const bootstrapToken = readBootstrapToken(apiServer)
  if (bootstrapToken) {
    const result = await call('/api/auth/bootstrap', {
      body: {
        bootstrapToken,
        displayName: 'Navigation E2E',
        email: 'navigation-e2e@example.com',
        password: 'navigation-e2e-password',
      },
      method: 'POST',
    })
    return { origin: 'bootstrap', token: result.token }
  }
  const result = await call('/api/auth/dev-login')
  return { origin: 'dev-login', token: result.token }
}

const ensureChannels = async (token) => {
  const existing = await call('/api/channels', { token })
  const bySlug = new Map(existing.map((channel) => [channel.slug ?? channel.label, channel]))
  const wanted = []
  for (const label of CHANNEL_LABELS) {
    const slug = label.toLowerCase().replace(/\s+/gu, '-')
    const found = bySlug.get(slug)
    if (found) {
      wanted.push(found)
      continue
    }
    wanted.push(await call('/api/channels', {
      body: { label, scope: 'standalone', visibility: 'public' },
      method: 'POST',
      token,
    }))
  }
  return wanted
}

const ensureProject = async (token) => {
  const projects = await call('/api/projects', { token })
  const teams = await call('/api/teams', { token })
  if (projects.length > 0) {
    const project = projects.find((candidate) =>
      teams.some((team) => team.projectIds?.includes(candidate.id)))
    if (!project) throw new Error('the fixture has projects but none has an owning team')
    const team = teams.find((candidate) => candidate.projectIds?.includes(project.id))
    if (!team) throw new Error(`the fixture project ${project.id} has no owning team`)
    return { project, team }
  }
  const team = teams[0]
  if (!team) throw new Error('the fixture needs an existing team before creating a project')
  const project = await call('/api/projects', {
    body: { name: 'Navigation E2E Project', teamId: team.id },
    method: 'POST',
    token,
  })
  return { project, team }
}

/**
 * A project starts with one board, and a switcher with one choice is not
 * rendered — so a case that needs the strip asks for a second board first.
 * Idempotent: the suite reuses a database that may already carry it.
 */
export const ensureSecondBoard = async (token, projectId, name) => {
  const boards = await call(`/api/projects/${projectId}/boards`, { token })
  const existing = boards.find((board) => board.name === name)
  if (existing) return existing
  return call(`/api/projects/${projectId}/boards`, {
    body: { name },
    method: 'POST',
    token,
  })
}

export const seedTeam = async (apiServer) => {
  const session = await signIn(apiServer)
  const channels = await ensureChannels(session.token)
  const { project, team } = await ensureProject(session.token)
  if (channels.length < 2) {
    throw new Error('the suite needs two reachable channels; the seed produced fewer')
  }
  return {
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      slug: channel.slug ?? channel.label,
      defaultThreadId: channel.defaultThreadId,
    })),
    origin: session.origin,
    project: { id: project.id, name: project.name },
    team: { id: team.id },
    token: session.token,
  }
}

/**
 * A worker-classified trigger health transition is seeded after the ordinary
 * owner route creates the agent. The worker's transition and alert-dispatch
 * tests own how the classified trigger and alert rows are written; this
 * navigation fixture owns the person-facing bell -> exact recovery control
 * journey, so it seeds that already-failed state directly.
 */
export const seedTriggerHealthAlert = async (seed) => {
  const suffix = Date.now().toString(36)
  const title = `Reauthorize schedule ${suffix}`
  const agent = await call('/api/agents', {
    body: { name: `Trigger health ${suffix}`, systemPrompt: 'Navigation alert proof.' },
    method: 'POST',
    token: seed.token,
  })
  const me = await call('/api/auth/me', { token: seed.token })
  const prisma = new PrismaClient()
  try {
    const trigger = await prisma.agentTrigger.create({
      data: {
        agentId: agent.id,
        config: {},
        healthDetail: 'The captured authority needs to be renewed.',
        healthReason: 'launch_origin_invalid',
        healthRevision: 1,
        name: title,
        status: 'needs_reauthorization',
        targetChannelId: seed.channels[0].id,
        targetThreadId: seed.channels[0].defaultThreadId,
        type: 'manual',
      },
    })
    await prisma.userAlert.create({
      data: {
        eventKey: `navigation-trigger-health:${trigger.id}`,
        kind: 'trigger_health',
        organizationId: me.context.organizationId,
        triggerId: trigger.id,
        userId: me.user.id,
      },
    })
  } finally {
    await prisma.$disconnect()
  }
  return { title, triggerId: trigger.id }
}

/**
 * Give the logout case its own account. Logout bumps a user's token version,
 * so even a second session for the suite owner would revoke every later case.
 */
export const seedBrowserPushSession = async (ownerToken) => {
  const users = await call('/api/users', { token: ownerToken })
  if (!users.some((user) => user.email === ISOLATED_BROWSER_PUSH_USER.email)) {
    await call('/api/users', {
      body: { ...ISOLATED_BROWSER_PUSH_USER, role: 'member' },
      method: 'POST',
      token: ownerToken,
    })
  }
  const session = await call('/api/auth/session', {
    body: {
      email: ISOLATED_BROWSER_PUSH_USER.email,
      password: ISOLATED_BROWSER_PUSH_USER.password,
    },
    method: 'POST',
  })
  return session.token
}

/**
 * Seed through the public dashboard routes, then add the one agent-authored
 * message pointer that production creates through `dashboard_present`. The
 * pointer itself is intentionally not a public user-message field, so direct
 * insertion is test-only; all source, dashboard, widget, delta and realtime
 * behaviour below still crosses the real HTTP surface.
 */
export const seedDashboardWorkspace = async (input) => {
  const runId = Date.now().toString(36)
  const title = `Quarterly revenue ${runId}`
  const source = await call('/api/dashboard-sources/import', {
    body: {
      content: 'quarter,revenue\nQ1,12\nQ2,28\nQ3,19\n',
      format: 'csv',
      name: `Dashboard workspace CSV ${runId}`,
    },
    method: 'POST',
    token: input.token,
  })
  const dashboard = await call('/api/dashboards', {
    body: { home: 'personal', title },
    method: 'POST',
    token: input.token,
  })
  await call(`/api/dashboards/${dashboard.id}/widgets`, {
    body: {
      binding: { category: 'quarter', series: [{ key: 'revenue', label: 'Revenue' }] },
      kind: 'bar',
      presentation: { title: 'Revenue by quarter' },
      schemaVersion: 1,
      sourceId: source.id,
    },
    method: 'POST',
    token: input.token,
  })
  const current = await call(`/api/dashboards/${dashboard.id}`, { token: input.token })
  const prisma = new PrismaClient()
  try {
    await prisma.message.create({
      data: {
        content: `Dashboard ready: ${title}`,
        metadata: { dashboardPresentation: { dashboardId: dashboard.id, schemaVersion: 1 } },
        role: 'assistant',
        threadId: input.channel.defaultThreadId,
      },
    })
  } finally {
    await prisma.$disconnect()
  }
  return { dashboard: current, source, title }
}

/** Ensure one real chat crosses the API's first 50-row history boundary. */
export const seedMessageHistory = async (token, threadId) => {
  const current = await request(`/api/threads/${threadId}/messages?limit=50`, { token })
  if (current?.meta?.hasMore) return

  const missing = 55 - (current?.data?.length ?? 0)
  for (let index = 0; index < missing; index += 1) {
    await call(`/api/threads/${threadId}/messages`, {
      body: { content: `History pagination proof ${String(index + 1).padStart(2, '0')}` },
      method: 'POST',
      token,
    })
  }
}

/** Seed an agent-owned history that crosses the Messages tab's first-page boundary. */
export const seedAgentMessageHistory = async (seed) => {
  const suffix = Date.now().toString(36)
  const createAgent = (name) => call('/api/agents', {
    body: { name, systemPrompt: 'Navigation pagination proof.' },
    method: 'POST',
    token: seed.token,
  })
  const [first, second] = await Promise.all([
    createAgent(`History pager A ${suffix}`),
    createAgent(`History pager B ${suffix}`),
  ])
  const prisma = new PrismaClient()
  try {
    await prisma.message.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        agentId: first.id,
        content: `Agent pagination proof ${String(index + 1).padStart(2, '0')}`,
        role: 'assistant',
        threadId: seed.channels[0].defaultThreadId,
      })),
    })
  } finally {
    await prisma.$disconnect()
  }
  return { first, second }
}

const ensureKnowledgePage = async (token, spaceId, title) => {
  const pages = await call(`/api/knowledge-base/spaces/${spaceId}/pages`, { token })
  const existing = pages.find((page) => page.title === title)
  if (existing) return existing
  return call(`/api/knowledge-base/spaces/${spaceId}/pages`, {
    body: { body: `<p>${title}</p>`, title },
    method: 'POST',
    token,
  })
}

const ensureKnowledgeSpace = async (token, projectId, name) => {
  const spaces = await call('/api/knowledge-base/spaces?limit=100', { token })
  const existing = spaces.find((space) => space.name === name)
  if (existing) return existing
  return call('/api/knowledge-base/spaces', {
    body: { name, projectId },
    method: 'POST',
    token,
  })
}

/** Seed every Knowledge destination needed by the cross-navigation matrix. */
export const seedKnowledgeNavigation = async (token, projectId) => {
  const myDocsRef = await call('/api/knowledge-base/my-docs', {
    body: {},
    method: 'POST',
    token,
  })
  const myDocs = await call(`/api/knowledge-base/spaces/${myDocsRef.spaceId}`, { token })
  const alpha = await ensureKnowledgeSpace(token, projectId, 'Navigation Alpha')
  const beta = await ensureKnowledgeSpace(token, projectId, 'Navigation Beta')
  return [
    {
      id: myDocs.id,
      name: myDocs.name,
      page: await ensureKnowledgePage(token, myDocs.id, 'Personal route proof'),
      section: 'my-docs',
    },
    {
      id: alpha.id,
      name: alpha.name,
      page: await ensureKnowledgePage(token, alpha.id, 'Alpha route proof'),
      section: 'spaces',
    },
    {
      id: beta.id,
      name: beta.name,
      page: await ensureKnowledgePage(token, beta.id, 'Beta route proof'),
      section: 'spaces',
    },
  ]
}
