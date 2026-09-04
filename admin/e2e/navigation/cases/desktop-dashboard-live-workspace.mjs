// The full static-dashboard journey: material crosses the real import API,
// the conversation renders the worker-authored pointer, the workspace opens
// in-place, and a later versioned delta reaches both active views over WS.
import { createChecks } from '../lib/expect.mjs'
import { gotoChannel, shot } from '../lib/page.mjs'
import { call, seedDashboardWorkspace } from '../lib/seed.mjs'

export const desktopDashboardLiveWorkspace = {
  name: 'desktop-dashboard-live-workspace',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-dashboard-live-workspace')
    const channel = seed.channels[0]
    const { dashboard, source } = await seedDashboardWorkspace({ channel, token: seed.token })

    // Conversation cards must not load the workspace-sized datasets. Capture
    // this before navigation so the assertion proves the preview's first paint
    // uses the bounded projection contract.
    const compactProjection = page.waitForResponse((response) =>
      response.request().method() === 'GET'
      && /\/api\/dashboard-widgets\/[^/]+\/data\?compact=true$/u.test(response.url()),
    )
    await gotoChannel(page, channel.id)
    await compactProjection
    const message = page.locator('article').filter({ hasText: `Dashboard ready: ${dashboard.title}` })
    const preview = message.locator('[data-testid="dashboard-presentation-preview"]')
    const card = preview.getByRole('button', { name: `Open ${dashboard.title} in workspace` })
    await preview.waitFor({ state: 'visible', timeout: 60_000 })
    checks.ok('the chat preview requests bounded widget data', true)
    const frames = [await shot(page, 'desktop-dashboard-live-workspace', '00-chat-card')]

    await card.click()
    await page.waitForURL(new RegExp(`/channels/${channel.id}/threads/${channel.defaultThreadId}/dashboards/${dashboard.id}$`, 'u'))
    await page.getByRole('complementary', { name: 'Dashboard workspace' }).waitFor({ state: 'visible' })
    frames.push(await shot(page, 'desktop-dashboard-live-workspace', '01-workspace-panel'))

    await call(`/api/dashboards/${dashboard.id}/deltas`, {
      body: {
        baseRevision: dashboard.revision,
        mutationId: '91f7d8c3-b2a1-4d90-8e6f-001122334455',
        operations: [{
          presentation: {
            attributions: [{ label: 'Uploaded quarterly CSV', sourceId: source.id, visible: true }],
            filters: [{
              column: 'quarter',
              id: '91f7d8c3-b2a1-4d90-8e6f-001122334456',
              label: 'Q2 only',
              sourceId: source.id,
              values: ['Q2'],
            }],
            insights: [{
              id: '91f7d8c3-b2a1-4d90-8e6f-001122334457',
              text: 'Q2 is the strongest quarter.',
              tone: 'success',
            }],
            style: 'executive',
          },
          type: 'set_presentation',
        }],
        schemaVersion: 1,
      },
      method: 'POST',
      token: seed.token,
    })
    const workspace = page.getByRole('complementary', { name: 'Dashboard workspace' })
    await workspace.getByText('Q2 is the strongest quarter.').waitFor({ state: 'visible', timeout: 30_000 })
    checks.ok('the compact dashboard card is in the conversation', await card.isVisible())
    checks.ok(
      'the compact card receives the same live delta as the workspace',
      await preview.getByText('Q2 is the strongest quarter.').count() === 1,
    )
    checks.ok(
      'the full dashboard opens in the right workspace panel without a modal',
      await page.getByRole('dialog').count() === 0,
    )
    checks.ok('the versioned conversational edit is visible in the workspace', true)
    frames.push(await shot(page, 'desktop-dashboard-live-workspace', '02-live-update'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
