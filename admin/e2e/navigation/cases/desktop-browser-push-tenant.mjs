// A browser PushSubscription outlives a Nessie session. Disabling notifications
// must remove only the current organization enrollment; it must not unsubscribe
// the browser and break another organization that deliberately registered it.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { call, seedBrowserPushSession } from '../lib/seed.mjs'

const ENDPOINT = 'https://push.fixture.test/shared-browser'

const installPushFixture = async (page) => {
  await page.addInitScript((endpoint) => {
    let unsubscribeCalls = 0
    const messages = []
    const serverKey = new Uint8Array(65)
    serverKey[0] = 4
    const subscription = {
      endpoint,
      options: { applicationServerKey: serverKey.buffer },
      toJSON: () => ({ endpoint, keys: { auth: 'fixture-auth', p256dh: 'fixture-key' } }),
      unsubscribe: async () => {
        unsubscribeCalls += 1
        return true
      },
    }
    const registration = {
      active: { postMessage: (message) => messages.push(message) },
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
    }
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted', requestPermission: async () => 'granted' },
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    })
    Object.defineProperty(window, '__webPushFixture', {
      configurable: true,
      value: { messages: () => messages, unsubscribeCalls: () => unsubscribeCalls },
    })
  }, ENDPOINT)
}

export const desktopBrowserPushTenant = {
  isolatedSession: (seed) => seedBrowserPushSession(seed.token),
  name: 'desktop-browser-push-tenant',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-browser-push-tenant')
    let registrations = [ENDPOINT]
    let removals = 0
    let logoutRemovals = 0
    await installPushFixture(page)
    await page.route('**/api/push/web/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === '/api/push/web/config') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: { enabled: true, publicKey: 'fixture-public-key', registeredEndpoints: registrations },
          }),
        })
        return
      }
      if (request.method() === 'POST' && url.pathname === '/api/push/web/unsubscribe') {
        const body = request.postDataJSON()
        if (body?.endpoint !== ENDPOINT) throw new Error('settings removed an unexpected browser endpoint')
        removals += 1
        registrations = registrations.filter((endpoint) => endpoint !== body.endpoint)
        await route.fulfill({ status: 204 })
        return
      }
      if (request.method() === 'POST' && url.pathname === '/api/push/web/logout') {
        logoutRemovals += 1
        registrations = []
        await route.fulfill({ status: 204 })
        return
      }
      await route.continue()
    })

    await gotoPath(page, '/settings/account?tab=notifications')
    await page.getByText('Enabled for this organization on this browser').waitFor()
    await page.getByRole('switch', { name: 'Toggle browser notifications' }).click()
    await page.getByText('Disabled for this organization', { exact: true }).waitFor()
    const frames = [await shot(page, 'desktop-browser-push-tenant', '00-disabled-current-tenant')]

    checks.equal('the current tenant registration is removed once', removals, 1)
    checks.equal('the browser subscription remains for another tenant', await page.evaluate(
      () => window.__webPushFixture.unsubscribeCalls(),
    ), 0)
    checks.equal('the visible state follows this tenant registration', registrations.length, 0)
    // A second organization can deliberately enroll this same browser for the
    // same person. Logout then clears those retained enrollments before a
    // different account is allowed to use the endpoint.
    registrations = [ENDPOINT]
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('button', { name: 'Log out' }).click()
    await page.waitForURL('**/login')
    checks.equal('logout removes retained browser enrollments for the old person', logoutRemovals, 1)
    checks.equal('logout clears the service worker notification owner', await page.evaluate(() => {
      const messages = window.__webPushFixture.messages()
      return messages.length > 0 ? messages.at(-1).userId : 'missing'
    }), null)
    const sharedChannels = await call('/api/channels', { token: seed.token })
    checks.ok(
      'logout leaves the shared suite session authorized for the next case',
      sharedChannels.some((channel) => channel.id === seed.channels[0].id),
    )
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
