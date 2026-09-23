import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The executor run launcher's eighth bundle: "Local apps on this machine".
 *
 * A pure fixture suite — the real dialog and the real API client, with the
 * runner answering `/api/**` — so it needs the admin and nothing behind it.
 * It pins three things a screenshot alone cannot:
 *
 * - the option list, in order, so a bundle cannot quietly drop out of the
 *   doorway while the schema and the worker still accept it;
 * - the availability request and the launch payload carry exactly
 *   `['mcp.tools', 'mcp.call']`, because the bundle is the whole grant and a
 *   dialog posting one operation of the pair renders identically;
 * - candidates stay opaque: the row names a scope and nothing else, and when
 *   no candidate exists the existing explanation copy renders.
 *
 * It refuses to adopt an admin already listening, so a run beside another
 * checkout's dev server cannot drive that checkout's dialog.
 */

const AGENT_ID = '00000000-0000-4000-8000-0000000000a7'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b7'
const THREAD_ID = '00000000-0000-4000-8000-0000000000c7'
const HANDLE = `candidate-${'7'.repeat(40)}`
const LOCAL_APPS = ['mcp.tools', 'mcp.call']
const LOCAL_APPS_DESCRIPTION = 'Programs this machine’s owner named in its reviewed policy — '
  + 'for example a local browser or a coding agent. The agent sees each program’s own tools.'

const OPTIONS = [
  ['file.list', 'List workspace files'],
  ['file.read', 'Read a workspace file'],
  ['file.write', 'Write a sandbox draft'],
  ['file.write+workspace.review', 'Write and review a sandbox draft'],
  ['browser.open+browser.observe+browser.act+sandbox.stop', 'Act in an approved site'],
  ['command.run+workspace.review+sandbox.stop', 'Run and review a workspace command'],
  ['coding.launch+coding.observe+workspace.review+sandbox.stop', 'Work in a managed Codex session'],
  ['mcp.tools+mcp.call', 'Local apps on this machine'],
]

const uuid = (tail) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/executor-run-launcher')

// One context per case: the route decides what the machine can offer, and a
// case records every request it sees so it can assert on the wire.
const openCase = async (browser, { localAppsReady, width }) => {
  const context = await browser.newContext({ viewport: { height: 900, width } })
  const availability = []
  const launches = []
  await context.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.method() === 'POST' ? request.postDataJSON() : null
    const respond = (data) => route.fulfill({ json: { data } })
    if (path === '/api/executor-availability') {
      availability.push(body)
      const localApps = JSON.stringify(body.operationKeys) === JSON.stringify(LOCAL_APPS)
      if (localApps && localAppsReady) {
        return respond({
          candidates: [{
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            handle: HANDLE,
            operationKeys: LOCAL_APPS,
            readiness: 'ready',
            scopeKind: 'private',
          }],
          explanations: [],
        })
      }
      return respond({
        candidates: [],
        explanations: [{
          readiness: 'unavailable',
          reason: localApps ? 'descriptor_unreviewed' : 'operation_ungranted',
        }],
      })
    }
    if (path === `/api/threads/${THREAD_ID}/executor-runs`) {
      launches.push(body)
      const runId = uuid('d7')
      return respond({
        bindings: LOCAL_APPS.map((operationKey, index) => ({
          bindingId: uuid(`e${index}`),
          capabilityRevision: 3,
          fence: '1',
          operationKey,
          runId,
        })),
        messageId: uuid('f7'),
        runId,
        taskId: uuid('a8'),
      })
    }
    throw new Error(`Unexpected fixture request ${request.method()} ${path}`)
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/executor-run-launcher/index.html`)
  await page.getByRole('dialog').getByText('Run on an executor', { exact: true }).waitFor()
  return { availability, context, errors, launches, page }
}

const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  await mkdir(screenshots, { recursive: true })

  for (const width of [1280, 390]) {
    const { availability, context, errors, launches, page } = await openCase(browser, {
      localAppsReady: true,
      width,
    })
    const capability = page.getByLabel('Executor capability')
    const options = await capability.locator('option').evaluateAll((nodes) => (
      nodes.map((node) => [node.value, node.textContent])
    ))
    assert.deepEqual(options, OPTIONS, 'the launcher offers the eight bundles, local apps last')

    await capability.selectOption('mcp.tools+mcp.call')
    await page.getByText(LOCAL_APPS_DESCRIPTION, { exact: true }).waitFor()
    await page.getByText('Private executor', { exact: true }).waitFor()
    const asked = availability.at(-1)
    assert.deepEqual(asked, { agentId: AGENT_ID, operationKeys: LOCAL_APPS, projectId: PROJECT_ID })

    // Opaque candidates: the dialog is handed a scope and a handle, and shows
    // the scope. A server name or an executor label here would be the dialog
    // inventing what the resolver deliberately withholds.
    const dialogText = await page.getByRole('dialog').innerText()
    assert.doesNotMatch(dialogText, /kelpie|ollama|coding-sessions|candidate-/i)
    assert.ok(await page.getByRole('radio').isChecked(), 'the only candidate is preselected')
    await page.screenshot({ fullPage: true, path: resolve(screenshots, `local-apps-${width}.png`) })

    await page.getByRole('button', { name: 'Start executor run', exact: true }).click()
    await page.getByText('Executor run started', { exact: true }).waitFor()
    assert.deepEqual(launches, [{
      agentId: AGENT_ID,
      candidateHandle: HANDLE,
      content: 'Take the tickets one at a time.',
      operationKeys: LOCAL_APPS,
    }], 'the launch posts exactly the local-apps pair under the chosen candidate')
    assert.equal(await page.getByRole('dialog').count(), 0, 'a launch closes the dialog')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`executor-run-launcher: local apps at ${width}px launched with the pair`)
  }

  // No machine offers the pair: the existing explanation copy, and nothing to
  // start. The explanation is the resolver's reason, never a machine name.
  {
    const { context, errors, launches, page } = await openCase(browser, {
      localAppsReady: false,
      width: 1280,
    })
    await page.getByLabel('Executor capability').selectOption('mcp.tools+mcp.call')
    await page.getByText('No executor ready: descriptor unreviewed.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('radio').count(), 0)
    assert.ok(
      await page.getByRole('button', { name: 'Start executor run', exact: true }).isDisabled(),
      'nothing to start without a candidate',
    )
    await page.screenshot({ fullPage: true, path: resolve(screenshots, 'local-apps-unavailable.png') })
    assert.deepEqual(launches, [])
    assert.deepEqual(errors, [])
    await context.close()
    console.log('executor-run-launcher: no candidate renders the explanation')
  }

  console.log(`Executor run launcher proofs passed; screenshots: ${screenshots}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
