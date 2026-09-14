// Three widths, one page each, held open for the whole run.
//
// Every case is asserted and photographed at all three, because the parts this
// feature adds are exactly the parts that move between them: the rail stands
// down on a phone and the header picks the tools up, the column becomes a
// screen, and a row's trailing chip is the first thing a narrow layout drops.
// A case proved only at 1280px would prove none of that.
//
// The pages are reused rather than reopened per case: opening a context costs
// a second and the suite has a four-minute budget, and a case that navigates
// to its own URL first has nothing to inherit from the case before it.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { openViewportContext } from '../navigation/lib/browser.mjs'

/** The lib's own three bands (`navigation/lib/config.mjs`): 1280×800, 768×1024, 390×844. */
export const VIEWPORT_NAMES = ['desktop', 'tablet', 'phone']

export const openGallery = async (browser, { screenshots, token }) => {
  const entries = []
  for (const name of VIEWPORT_NAMES) {
    const context = await openViewportContext(browser, { name, token })
    const page = await context.newPage()
    // The rail remembers which tool a person left open, per agent
    // (`chatToolStorageKey`), and restores it a beat after the page mounts —
    // which would make "press the doorway" mean "close the column" on every
    // visit after the first. The suite starts each load from closed instead, so
    // pressing a doorway always opens something.
    await page.page.addInitScript(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('nessie.chatTool.')) window.localStorage.removeItem(key)
      }
    })
    entries.push({ context, name, page })
  }
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.page.page]))
  return {
    close: async () => {
      for (const entry of entries) await entry.context.close().catch(() => {})
    },
    pages: byName,
    /**
     * Run one case at all three widths and photograph each.
     *
     * `each(page, viewport)` carries the case's own assertions: it is handed
     * the width so a case can say the true thing at that width — a phone has
     * no rail, and asserting one there would be asserting a bug.
     */
    capture: async (caseName, each) => {
      const directory = resolve(screenshots, caseName)
      await mkdir(directory, { recursive: true })
      for (const entry of entries) {
        await each(entry.page.page, entry.name)
        await entry.page.page.screenshot({ path: resolve(directory, `${entry.name}.png`) })
      }
    },
  }
}

/** One page, one width — the phone flow, whose steps have no wider counterpart. */
export const shot = async (page, screenshots, caseName, step) => {
  const directory = resolve(screenshots, caseName)
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: resolve(directory, `${step}.png`) })
}
