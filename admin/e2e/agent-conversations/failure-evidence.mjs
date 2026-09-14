import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * What was on screen and what the model was asked, at the moment it broke.
 *
 * A failing browser assertion says which selector never appeared; it never says
 * why. The three artefacts here answer the three questions that always follow:
 * what did the page actually render, what did the inference side see, and where
 * in the suite did it stop.
 */
export const saveFailureEvidence = async ({ error, model, pages, screenshots }) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  await writeFile(resolve(screenshots, 'failure.txt'), `${detail}\n`)
  for (const [name, page] of Object.entries(pages)) {
    if (!page) continue
    const body = await page.locator('body').innerText().catch(() => '')
    await writeFile(resolve(screenshots, `failure-${name}.txt`), `${page.url()}\n\n${body}\n`)
    await page.screenshot({ path: resolve(screenshots, `failure-${name}.png`) }).catch(() => {})
  }
  if (model) {
    await writeFile(
      resolve(screenshots, 'failure-inference-requests.json'),
      `${JSON.stringify(model.requests(), null, 2)}\n`,
    )
  }
}
