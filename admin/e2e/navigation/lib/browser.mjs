// One Chromium, one context per viewport, one page per case. The session
// token is planted in localStorage before the first script runs — the same
// key the admin reads (`nessie.admin.token`) and the same thing
// `worker/verify-edit-ui.mjs` does, so the suite never drives the login form.
//
// A page per case matters: a case that fails mid-navigation leaves the page
// with an aborted load, and the next case's goto inherits it.
import { chromium } from 'playwright-core'
import { VIEWPORTS, chromiumPath, headed } from './config.mjs'

export const launchBrowser = async () => {
  const executablePath = chromiumPath()
  try {
    return await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: !headed(),
    })
  } catch (error) {
    const hint = executablePath
      ? `CHROMIUM_PATH=${executablePath} did not launch`
      : 'no CHROMIUM_PATH is set and playwright-core found no downloaded Chromium'
    throw new Error(`${hint}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const openViewportContext = async (browser, { name, token }) => {
  const viewport = VIEWPORTS[name]
  if (!viewport) throw new Error(`unknown viewport "${name}"`)
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    hasTouch: viewport.hasTouch,
    viewport: { height: viewport.height, width: viewport.width },
  })
  await context.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value) },
    ['nessie.admin.token', token],
  )
  return {
    close: () => context.close(),
    name,
    newPage: async () => {
      const page = await context.newPage()
      page.setDefaultTimeout(30_000)
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error)))
      return { close: () => page.close(), errors, page }
    },
    viewport,
  }
}
