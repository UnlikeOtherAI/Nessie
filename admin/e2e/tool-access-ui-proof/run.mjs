import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

const token = process.env.UI_TOKEN
const agentId = process.env.UI_AGENT_ID
const phase = process.env.UI_PROOF_PHASE
if (!token || !agentId) throw new Error('UI proof credentials are missing.')
if (phase !== 'enable' && phase !== 'revoke') {
  throw new Error('UI_PROOF_PHASE must be enable or revoke.')
}

const entries = JSON.parse(process.env.UI_ENTRIES ?? 'null')
if (!Array.isArray(entries) || entries.length === 0 || entries.some(
  (entry) => !Array.isArray(entry) || entry.length !== 2
    || entry.some((value) => typeof value !== 'string' || value.length === 0),
)) {
  throw new Error('UI_ENTRIES must be a nonempty JSON array of [toolId, label] pairs.')
}

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
  const url = `http://localhost:5455/agents/${agentId}?agentTab=tools`
  const responses = []
  page.on('response', (response) => {
    if (response.url().includes('/api/mcp/tools')) responses.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('input[type=search]').waitFor()

  const before = {}
  for (const [key, label] of entries) {
    const search = page.locator('input[type=search]')
    await search.fill(key)
    const toggle = page.getByRole('switch', { name: `${beforeVerb} ${label}` })
    await toggle.waitFor()
    before[key] = await toggle.getAttribute('aria-checked')
    if (before[key] !== expectedBefore) throw new Error(`${key} did not start ${expectedBefore}.`)
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
  await page.locator('input[type=search]').waitFor()

  const after = {}
  for (const [key, label] of entries) {
    const search = page.locator('input[type=search]')
    await search.fill(key)
    const toggle = page.getByRole('switch', { name: `${afterVerb} ${label}` })
    await toggle.waitFor()
    after[key] = await toggle.getAttribute('aria-checked')
    if (after[key] !== expectedAfter) throw new Error(`${key} did not persist ${expectedAfter}.`)
    await page.screenshot({ path: `${proofDir}/${revoke ? 'revoked' : 'enabled'}-${key}.png`, fullPage: true })
  }
  process.stdout.write(`${JSON.stringify({ after, before, responses, url })}\n`)
  await context.close()
} finally {
  await browser.close()
}
