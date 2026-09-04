// The team the cases navigate: one organisation, one project and at
// least two channels a phone list can push into. Everything is created
// through the same REST routes a person's clicks call — there is no second
// seeding path to drift from them.
import { API_URL } from './config.mjs'
import { readBootstrapToken } from './servers.mjs'

const CHANNEL_LABELS = ['Design Review', 'Release Notes']

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

const call = async (path, options) => (await request(path, options))?.data

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
  if (projects.length > 0) return projects[0]
  return call('/api/projects', {
    body: { name: 'Navigation E2E Project' },
    method: 'POST',
    token,
  })
}

export const seedTeam = async (apiServer) => {
  const session = await signIn(apiServer)
  const channels = await ensureChannels(session.token)
  const project = await ensureProject(session.token)
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
    token: session.token,
  }
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
