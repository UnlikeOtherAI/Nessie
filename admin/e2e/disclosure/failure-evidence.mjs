import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const writePageEvidence = async (page, screenshots, name) => {
  if (!page) return

  const body = await page.locator('body').innerText().catch(() => '')
  await writeFile(resolve(screenshots, `failure-${name}.txt`), body)
  const editor = await page.locator('form.admin-compose:visible [role="textbox"]').evaluate((node) => ({
    html: node.outerHTML,
    selection: window.getSelection()?.toString() ?? '',
  })).catch(() => ({}))
  await writeFile(resolve(screenshots, `failure-${name}-editor.json`), `${JSON.stringify(editor, null, 2)}\n`)
  await page.screenshot({
    path: resolve(screenshots, `failure-${name}.png`),
    fullPage: true,
  }).catch(() => {})
}

export const saveFailureEvidence = async ({ audiencePage, error, screenshots, sourcePage }) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  await writeFile(resolve(screenshots, 'failure.txt'), `${detail}\n`)
  await writePageEvidence(audiencePage, screenshots, 'public-recipient')
  const realtime = await audiencePage?.evaluate(() => ({
    activity: window.__disclosureActivityProbe?.events ?? [],
    events: window.__disclosureEventProbe?.events ?? [],
  })).catch(() => ({}))
  await writeFile(
    resolve(screenshots, 'failure-public-recipient-realtime.json'),
    `${JSON.stringify(realtime, null, 2)}\n`,
  )
  await writePageEvidence(sourcePage, screenshots, 'source-author')
}
