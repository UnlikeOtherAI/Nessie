import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

import { resolveAdminPort } from '../../../scripts/dev-ports.mjs'

const token = process.env.UI_TOKEN
const agentId = process.env.UI_AGENT_ID
const phase = process.env.UI_PROOF_PHASE
if (!token || !agentId) throw new Error('UI proof credentials are missing.')
if (phase !== 'enable' && phase !== 'revoke') {
  throw new Error('UI_PROOF_PHASE must be enable or revoke.')
}

const entries = JSON.parse(process.env.UI_ENTRIES ?? 'null')
// [toolId, label] or [toolId, label, explanation]: an explanation is text the
// entry must show beside its switch, as a capability grant explains itself.
if (!Array.isArray(entries) || entries.length === 0 || entries.some(
  (entry) => !Array.isArray(entry) || entry.length < 2 || entry.length > 3
    || entry.some((value) => typeof value !== 'string' || value.length === 0),
)) {
  throw new Error('UI_ENTRIES must be a nonempty JSON array of [toolId, label, explanation?] entries.')
}

// The Tools tab's own search, by its placeholder: the admin shell carries
// other search boxes, and filling the first one filters nothing here.
const toolSearch = (page) => page.getByPlaceholder('Search tools…')

const revoke = phase === 'revoke'
const beforeVerb = revoke ? 'Disable' : 'Enable'
const afterVerb = revoke ? 'Enable' : 'Disable'
const expectedBefore = revoke ? 'true' : 'false'
const expectedAfter = revoke ? 'false' : 'true'
const browser = await chromium.launch({
  executablePath: process.env.UI_PROOF_CHROMIUM_PATH
    ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ accessToken }) => {
    localStorage.setItem('nessie.admin.token', accessToken)
    localStorage.setItem(
      'nessie.admin.token-mode',
      JSON.stringify({ mode: 'renewable', token: accessToken }),
    )
  }, { accessToken: token })
  const page = await context.newPage()
  const proofDir = 'artifacts/tool-access-ui-proof'
  await mkdir(proofDir, { recursive: true })
  // This worktree's admin (AGENTS.md → "Ports"), never a hardcoded default.
  const adminUrl = process.env.UI_PROOF_ADMIN_URL ?? `http://localhost:${resolveAdminPort()}`
  const url = `${adminUrl}/agents/${agentId}?agentTab=tools`
  const responses = []
  page.on('response', (response) => {
    if (response.url().includes('/api/mcp/tools')) responses.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await toolSearch(page).waitFor()

  const before = {}
  const explained = {}
  for (const [key, label, explanation] of entries) {
    const search = toolSearch(page)
    await search.fill(key)
    const toggle = page.getByRole('switch', { name: `${beforeVerb} ${label}` })
    await toggle.waitFor()
    before[key] = await toggle.getAttribute('aria-checked')
    if (before[key] !== expectedBefore) throw new Error(`${key} did not start ${expectedBefore}.`)
    if (explanation) {
      const text = page.getByText(explanation, { exact: false })
      await text.first().waitFor()
      explained[key] = await text.first().isVisible()
      if (!explained[key]) throw new Error(`${key} does not show its explanation.`)
    }
    await page.screenshot({ path: `${proofDir}/${revoke ? 'enabled' : 'initial'}-${key}.png`, fullPage: true })
    await toggle.click()
    await page.waitForFunction(
      (input) => document.querySelector(`[aria-label="${input.name}"]`)
        ?.getAttribute('aria-checked') === input.expected,
      { name: `${afterVerb} ${label}`, expected: expectedAfter },
    )
  }
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForFunction(() => {
    const button = document.querySelector('button.admin-button-primary')
    return button?.textContent?.trim() === 'Save changes' && button.hasAttribute('disabled')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await toolSearch(page).waitFor()

  const after = {}
  for (const [key, label] of entries) {
    const search = toolSearch(page)
    await search.fill(key)
    const toggle = page.getByRole('switch', { name: `${afterVerb} ${label}` })
    await toggle.waitFor()
    after[key] = await toggle.getAttribute('aria-checked')
    if (after[key] !== expectedAfter) throw new Error(`${key} did not persist ${expectedAfter}.`)
    await page.screenshot({ path: `${proofDir}/${revoke ? 'revoked' : 'enabled'}-${key}.png`, fullPage: true })
  }
  process.stdout.write(`${JSON.stringify({ after, before, explained, responses, url })}\n`)
  await context.close()
} finally {
  await browser.close()
}
