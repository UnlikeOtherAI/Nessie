import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/local-ollama-agents')
const admin = await startAdmin()
const browser = await launchBrowser()

try {
  await mkdir(screenshots, { recursive: true })
  const context = await browser.newContext({ viewport: { height: 1000, width: 1024 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/local-ollama-agents/index.html`)
  try {
    await page.getByRole('heading', { name: 'Local Ollama agents' }).waitFor()
  } catch (error) {
    throw new Error(`Local Ollama fixture did not render: ${errors.join(' | ')}\n${await page.locator('body').innerText()}`, {
      cause: error,
    })
  }

  // A browser has a truthful doorway, not a fake local scan. Every host state
  // describes its actual repair and nothing about GPUs, endpoints or tokens.
  const connections = page.getByTestId('connections')
  for (const expected of [
    'this browser never scans your device',
    'Open paired computers',
    'Online — ready for a selected local model.',
    'Offline — start Nessie Desktop or its executor on this computer.',
    'Unknown — Nessie cannot currently verify this connection.',
  ]) await connections.getByText(expected, { exact: false }).waitFor()
  assert.equal(await connections.getByRole('button', { name: /Find Ollama|Prepare this computer/i }).count(), 0)
  assert.equal(await connections.getByText(/GPU|token|context size/i).count(), 0)
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'connections-friendly-states.png') })

  // Executor detail reuses the same host controls, scoped to its one executor.
  const executor = page.getByTestId('executor-detail')
  await executor.getByText('Paired computer · offline', { exact: true }).waitFor()
  await executor.getByRole('button', { name: 'Pause local models', exact: true }).click()
  const callsAfterPause = await page.evaluate(() => window.localOllamaFixtureCalls)
  assert.ok(callsAfterPause.some((call) => call.path.endsWith('/hosts/00000000-0000-4000-8000-0000000000e1/pause')))
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'executor-shared-controls.png') })

  // Native/executor consent is an approval of an exact binding. It is not an
  // activation: Designer Save remains disabled until its server status moves.
  const designer = page.getByTestId('designer')
  const save = designer.getByRole('button', { name: 'Save agent', exact: true })
  assert.equal(await save.isDisabled(), true)
  await designer.getByRole('button', { name: 'Approve local model', exact: true }).click()
  await designer.getByRole('button', { name: 'Check executor approval', exact: true }).waitFor()
  assert.equal(await save.isDisabled(), true)
  const prepareCalls = await page.evaluate(() => window.localOllamaFixtureCalls)
  const prepare = prepareCalls.find((call) => call.path.endsWith('/agents/agent-exact/local-inference/prepare'))
  assert.deepEqual(prepare?.body, {
    hostId: '00000000-0000-4000-8000-0000000000e1', manifestDigest: 'b'.repeat(64), modelName: 'gemma4:12b',
  })
  assert.equal(await designer.getByRole('button', { name: /Activate|Connect now/i }).count(), 0)
  await designer.getByRole('button', { name: 'Check executor approval', exact: true }).click()
  await designer.getByText('This computer approved the selected local model. Save the agent to activate it.').waitFor()
  assert.equal(await save.isDisabled(), false)
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'binding-save-gated.png') })

  // Availability is server-derived, distinct from human presence, and uses
  // the same component in the list and the agent detail.
  await page.getByTestId('agent-list').getByText('Local model online').waitFor()
  await page.getByTestId('agent-list').getByText('Local model offline').waitFor()
  await page.getByTestId('agent-detail').getByText('Local model availability unknown').waitFor()
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'agent-presence-states.png') })

  // An administrator may enable the team, while the more specific user view
  // correctly names the inherited lock and has no writable raw-key control.
  const policy = page.getByTestId('policy')
  const teamSwitch = policy.getByTestId('local-inference-policy-team').getByRole('switch')
  await teamSwitch.click()
  assert.equal(await teamSwitch.getAttribute('aria-checked'), 'true')
  const writes = await page.evaluate(() => window.localOllamaFixtureCalls)
  assert.ok(writes.some((call) => call.method === 'PUT' && call.path.endsWith('/inference.localAgents.enabled')))
  await policy.getByText('This has been set at the team level and cannot be changed here.').waitFor()
  assert.equal(await policy.getByTestId('local-inference-policy-user').getByRole('switch').isDisabled(), true)
  assert.equal(await policy.getByText(/raw key|host inventory|team offer/i).count(), 0)
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'team-policy-and-user-lock.png') })

  // Narrow rendering must preserve the browser's honest doorway and keyboard
  // reachability instead of hiding the repair beneath horizontal overflow.
  await page.setViewportSize({ height: 844, width: 390 })
  await page.getByRole('link', { name: 'Open paired computers', exact: true }).focus()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open paired computers')
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'phone-doorways-and-policy.png') })
  assert.deepEqual(errors, [], errors.join(' | '))
  await context.close()
  console.log(`Local Ollama browser proofs passed: ${screenshots}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
