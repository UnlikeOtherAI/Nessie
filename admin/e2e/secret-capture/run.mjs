import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { chromium } from 'playwright-core'

const ADMIN_URL = 'http://localhost:5455'
const SCREENSHOT = resolve('e2e/screenshots/secret-capture/new-message.png')
const NOW = '2026-09-04T12:00:00.000Z'
const IDS = {
  agent: '00000000-0000-4000-8000-000000000006',
  channel: '00000000-0000-4000-8000-000000000004',
  organization: '00000000-0000-4000-8000-000000000001',
  project: '00000000-0000-4000-8000-000000000002',
  team: '00000000-0000-4000-8000-000000000003',
  thread: '00000000-0000-4000-8000-000000000005',
  user: '00000000-0000-4000-8000-000000000007',
}

const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
  context: {
    bootstrapMode: false,
    organizationId: IDS.organization,
    projectId: IDS.project,
    teamId: IDS.team,
  },
  memberships: [{
    organizationId: IDS.organization,
    organizationName: 'Nessie Test',
    projects: [{
      projectId: IDS.project,
      projectName: 'Safety',
      teams: [{ teamId: IDS.team, teamName: 'Safety' }],
    }],
    role: 'owner',
  }],
  session: { issuedAt: NOW, sessionId: 'browser-e2e' },
  user: {
    displayName: 'Test Owner',
    email: 'owner@example.test',
    id: IDS.user,
    roleIds: ['owner'],
    superAdmin: false,
  },
}

const agent = {
  channelIds: [],
  createdAt: NOW,
  id: IDS.agent,
  lastActivityAt: NOW,
  name: 'Ada Agent',
  ownerUserId: IDS.user,
  role: 'Security helper',
  status: 'idle',
  todosEnabled: false,
  updatedAt: NOW,
  visibility: 'team',
}

const channel = {
  archivedAt: null,
  createdAt: NOW,
  defaultThreadId: IDS.thread,
  description: null,
  dmUserId: null,
  id: IDS.channel,
  isGroupDm: true,
  label: 'Ada Agent',
  lastMessageAt: null,
  memberRole: 'owner',
  organizationId: IDS.organization,
  projectId: IDS.project,
  projectName: 'Safety',
  slug: null,
  teamId: IDS.team,
  teamName: 'Safety',
  topic: null,
  type: 'dm',
  unreadCount: 0,
  updatedAt: NOW,
  visibility: 'private',
}

const responseForGet = (path) => {
  if (path === '/api/auth/me') return me
  if (path === '/api/agents' || path === '/api/agents?scope=all') return [agent]
  if (path === '/api/channels') return []
  if (path === '/api/projects' || path === '/api/teams') return []
  if (path === '/api/users' || path === '/api/favorites') return []
  if (path === '/api/integrations/products') return []
  if (path === '/api/alerts/summary') {
    return {
      assignedWork: { projects: {}, total: 0 },
      knowledge: { projects: {}, total: 0 },
      unreadCount: 0,
    }
  }
  if (path.startsWith('/api/threads/activity')) {
    return { hasMore: false, items: [], unreadTotal: 0 }
  }
  if (path === '/api/direct-messages/unread') return { items: [] }
  if (path === '/api/organizations/current') {
    return {
      administration: { status: 'allowed' },
      id: IDS.organization,
      logoAttachmentId: null,
      name: 'Nessie Test',
      nameManagedExternally: false,
      role: 'owner',
      stripImageMetadata: true,
    }
  }
  if (path === '/api/secrets') return []
  return []
}

const run = async () => {
  const openAiSecret = `sk-proj-${'aB3_'.repeat(14)}`
  const sendGridSecret = `SG.${'a'.repeat(24)}.${'b'.repeat(48)}`
  const requests = []
  const savedValues = []
  let sentMessage = null

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { height: 900, width: 1440 } })
  await context.addInitScript(() => {
    window.localStorage.setItem('nessie.admin.token', 'secret-capture-e2e-token')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const body = request.postData() ?? ''
    requests.push({ body, method, path: `${url.pathname}${url.search}` })

    if (url.pathname === '/api/events/stream') {
      await route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 })
      return
    }
    if (method === 'POST' && url.pathname === '/api/secrets') {
      const input = JSON.parse(body)
      savedValues.push(input.value)
      await route.fulfill({
        body: JSON.stringify({
          data: {
            createdAt: NOW,
            description: null,
            expiresAt: null,
            name: input.name,
            provider: null,
            reference: `secret://${input.name}`,
            rotatedAt: null,
            scopeId: IDS.user,
            scopeType: input.scopeType,
            status: 'active',
            updatedAt: NOW,
          },
        }),
        contentType: 'application/json',
        status: 200,
      })
      return
    }
    if (method === 'POST' && url.pathname === '/api/channels/conversations') {
      await route.fulfill({
        body: JSON.stringify({ data: channel }),
        contentType: 'application/json',
        status: 200,
      })
      return
    }
    if (method === 'POST' && url.pathname === `/api/threads/${IDS.thread}/messages`) {
      sentMessage = JSON.parse(body)
      await route.fulfill({
        body: JSON.stringify({ data: { message: {}, pendingAgentInvites: [] } }),
        contentType: 'application/json',
        status: 200,
      })
      return
    }

    await route.fulfill({
      body: JSON.stringify({ data: responseForGet(`${url.pathname}${url.search}`) }),
      contentType: 'application/json',
      status: 200,
    })
  })

  await page.goto(`${ADMIN_URL}/channels/new`)
  await page.getByRole('heading', { name: 'New message' }).waitFor()
  await page.getByPlaceholder('Type a name or email address').fill('Ada')
  await page.getByRole('button', { name: /Ada Agent/ }).click()
  const editor = page.getByRole('textbox').last()
  await editor.fill(`OPENAI_API_KEY=${openAiSecret}`)
  await editor.press('Shift+Enter')
  await editor.pressSequentially(`SENDGRID_API_KEY=${sendGridSecret}`)
  await editor.press('Enter')

  await page.getByRole('heading', { name: 'Credential 1 of 2' }).waitFor()
  const firstMaskedValue = await page.getByLabel('Value').inputValue()
  assert.match(firstMaskedValue, /^sk-proj-•+$/)
  assert.equal((await page.locator('body').innerText()).includes(openAiSecret), false)
  assert.equal((await page.locator('body').innerText()).includes(sendGridSecret), false)

  await mkdir(resolve(SCREENSHOT, '..'), { recursive: true })
  await page.screenshot({ fullPage: true, path: SCREENSHOT })
  await page.getByRole('button', { name: 'Save securely' }).click()

  await page.getByRole('heading', { name: 'Credential 2 of 2' }).waitFor()
  const secondMaskedValue = await page.getByLabel('Value').inputValue()
  assert.match(secondMaskedValue, /^SG\.•+$/)
  await page.getByRole('button', { name: 'Save securely' }).click()
  await page.waitForURL(`**/channels/${IDS.channel}`)

  assert.deepEqual(savedValues, [openAiSecret, sendGridSecret])
  assert.ok(sentMessage)
  assert.equal(JSON.stringify(sentMessage).includes(openAiSecret), false)
  assert.equal(JSON.stringify(sentMessage).includes(sendGridSecret), false)
  assert.match(sentMessage.content, /sk-proj-•+/)
  assert.match(sentMessage.content, /SG\.•+/)
  assert.match(sentMessage.content, /OPENAI_API_KEY, SENDGRID_API_KEY/)

  for (const request of requests) {
    if (request.path === '/api/secrets') continue
    assert.equal(request.body.includes(openAiSecret), false)
    assert.equal(request.body.includes(sendGridSecret), false)
  }
  const storage = await page.evaluate(() => JSON.stringify(window.localStorage))
  assert.equal(storage.includes(openAiSecret), false)
  assert.equal(storage.includes(sendGridSecret), false)

  await context.close()
  await browser.close()
  process.stdout.write(`Secret capture UI verified; screenshot: ${SCREENSHOT}\n`)
}

await run()
