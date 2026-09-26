import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const organizationId = '22222222-2222-4222-8222-222222222222'
const executorId = '33333333-3333-4333-8333-333333333333'
const pairingId = '44444444-4444-4444-8444-444444444444'
const projectId = '11111111-1111-4111-8111-111111111111'
const fingerprint = `sha256:${'a'.repeat(64)}`
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-pairing')
await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  if (adminMode() !== 'preview') {
    const served = await fetch(ADMIN_URL).then((response) => response.text())
    assert.ok(served.includes('@vite/client'), 'Pairing visual must run this worktree’s live Vite source')
  }
  await mkdir(output, { recursive: true })
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    let status = 'pending_pairing'
    let expired = false
    const claims = []
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const data = route.request().method() === 'POST' ? route.request().postDataJSON() : null
      const respond = (body) => route.fulfill({ json: { data: body } })
      if (path.endsWith('/options')) return respond({
        organization: { id: organizationId, name: 'UnlikeOtherAI' },
        scopes: ['private'],
        teams: [
          { id: 'uoa-product', name: 'Product', projectIds: [projectId] },
        ],
      })
      if (path.endsWith('/preview')) {
        if (data.code === '88888888') return route.fulfill({ status: 429, json: { error: { code: 'EXECUTOR_PAIRING_RATE_LIMITED', message: 'Wait' } } })
        if (data.code !== '01234567') return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unavailable' } } })
        return respond({
          expiresAt: new Date(Date.now() + (expired ? -1_000 : 600_000)).toISOString(),
          fingerprint, machineName: 'MINIS', pairingId,
          platformFacts: { platform: { architecture: 'x64', os: 'windows', osMajorVersion: 19045 }, sandboxBackend: 'hyperv', supervisor: 'service' },
        })
      }
      if (path.endsWith('/claim')) {
        claims.push(data)
        return respond({ executorId, pairingId, status: 'awaiting_confirmation' })
      }
      if (path === `/api/executors/${executorId}`) return respond({
        authorizationRevision: 1, createdAt: '2026-09-21T00:00:00.000Z', id: executorId,
        label: 'MINIS', profiles: [], scope: { kind: 'private', organizationId }, status,
        updatedAt: '2026-09-21T00:00:00.000Z',
      })
      throw new Error(`Unexpected fixture request ${path}`)
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`${ADMIN_URL}/e2e/executor-pairing/index.html`)
    await page.getByRole('button', { name: 'Pair a computer', exact: true }).click()
    await page.getByLabel('Eight-digit code').fill('88888888')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByText('Too many attempts.', { exact: false }).waitFor()
    await page.getByLabel('Eight-digit code').fill('87654321')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('alert').waitFor()
    await page.getByLabel('Eight-digit code').fill('01234567')
    await page.screenshot({ path: resolve(output, `code-${width}.png`) })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    assert.equal(await page.getByRole('combobox').count(), 0, 'Pairing uses the current team without a selector')
    assert.ok(await page.getByRole('button', { name: 'Pair computer', exact: true }).isDisabled())
    await page.getByLabel('The fingerprint matches').check()
    await page.screenshot({ path: resolve(output, `review-${width}.png`) })
    await page.getByRole('button', { name: 'Pair computer', exact: true }).click()
    await page.getByRole('heading', { name: 'Confirm on your computer' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Open computer', exact: true }).count(), 0)
    assert.equal(claims[0].code, '01234567', 'Leading zero is preserved')
    assert.equal(claims[0].teamId, 'uoa-product')
    assert.deepEqual(claims[0].scope, { kind: 'private', organizationId })
    const copy = await page.locator('body').innerText()
    assert.doesNotMatch(copy, /--state-dir|--enrollment|https:\/\/api|API|challenge/)
    status = 'offline'
    await page.getByRole('heading', { name: 'Computer paired' }).waitFor({ timeout: 12_000 })
    await page.getByRole('button', { name: 'Open computer', exact: true }).click()
    await page.getByText('Computer opened', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Pair a computer', exact: true }).click()
    assert.equal(await page.getByLabel('Eight-digit code').inputValue(), '')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').count(), 0)

    // All doorways pair personally into the current team; sharing lives on Permissions.
    await page.goto(`${ADMIN_URL}/e2e/executor-pairing/index.html?team=1`)
    await page.getByRole('button', { name: 'Pair a computer', exact: true }).click()
    await page.getByLabel('Eight-digit code').fill('01234567')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    assert.equal(await page.getByRole('combobox').count(), 0)
    await page.keyboard.press('Escape')

    // The existing project's doorway pins its actual team and project.
    await page.goto(`${ADMIN_URL}/e2e/executor-pairing/index.html?project=1`)
    await page.getByRole('button', { name: 'Pair a computer', exact: true }).click()
    await page.getByLabel('Eight-digit code').fill('01234567')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByText('UnlikeOtherAI · Product', { exact: true }).waitFor()
    await page.getByLabel('The fingerprint matches').check()
    status = 'revoked'
    await page.getByRole('button', { name: 'Pair computer', exact: true }).click()
    await page.getByText('Pairing was declined on the computer.', { exact: false }).waitFor()
    assert.deepEqual(claims[1].scope, { kind: 'private', organizationId })
    await page.getByRole('button', { name: 'Enter a new code', exact: true }).click()
    expired = true
    await page.getByLabel('Eight-digit code').fill('01234567')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByText('The code has expired.', { exact: false }).waitFor()
    assert.equal(claims.length, 2, 'Expired code never submits a claim')
    await page.goto(`${ADMIN_URL}/e2e/executor-pairing/index.html?pending=1`)
    await page.getByText('Open Nessie Executor on your computer to confirm', { exact: false }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm fingerprint', exact: true }).count(), 0)
    await page.screenshot({ path: resolve(output, `pending-${width}.png`) })
    // Both Desktop platforms use this same surface; the native picker and
    // confirmation transport are mocked, not the React pairing flow.
    for (const platform of ['windows', 'linux']) {
      status = 'pending_pairing'
      expired = false
      await context.exposeFunction(`confirmed_${platform}`, () => { status = 'offline' })
      await context.addInitScript((os) => {
        if (new URLSearchParams(location.search).get('native') !== os) return
        window.__nessieDesktopPlatform = os
        window.__companionCalls = []
        window.__TAURI_INTERNALS__ = { invoke: async (command) => {
          window.__companionCalls.push(command)
          if (command === 'executor_companion_status') return {
            availability: 'available', platform: os, executors: [], reason: '',
          }
          if (command === 'executor_companion_pairing_start') return '01234567'
          if (command === 'executor_companion_pairing_confirm') await window[`confirmed_${os}`]()
        } }
      }, platform)
      await page.goto(`${ADMIN_URL}/e2e/executor-pairing/index.html?native=${platform}`)
      await page.getByRole('button', { name: 'Pair a computer', exact: true }).click()
      await page.getByRole('button', { name: 'Connect this computer', exact: true }).click()
      assert.equal(await page.getByRole('combobox').count(), 0, 'Desktop pairing also uses the current team')
      await page.getByLabel('The fingerprint matches').check()
      await page.screenshot({ path: resolve(output, `desktop-${platform}-${width}.png`) })
      await page.getByRole('button', { name: 'Pair computer', exact: true }).click()
      await page.getByRole('heading', { name: 'Computer paired', exact: true }).waitFor()
      const nativeCalls = await page.evaluate(() => window.__companionCalls)
      assert.equal(nativeCalls.filter((call) => call === 'executor_companion_pairing_start').length, 1)
      assert.equal(nativeCalls.filter((call) => call === 'executor_companion_pairing_confirm').length, 1)
      assert.ok(!nativeCalls.includes('executor_companion_stop'), 'An existing connection is never stopped')
      await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(`Executor pairing flows passed; screenshots: ${output}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
