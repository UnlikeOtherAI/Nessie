// One place for every number, path and switch the navigation transition
// suite depends on. Ports are the repo's fixed local-dev ports (CLAUDE.md →
// "Ports — NON-NEGOTIABLE"); the viewports are the three widths §4.19 of
// docs/plans/2026-09-01-navigation-motion-system.md names.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const SUITE_ROOT = resolve(here, '..')
export const ADMIN_ROOT = resolve(SUITE_ROOT, '..', '..')
export const REPO_ROOT = resolve(ADMIN_ROOT, '..')
export const SCREENSHOT_ROOT = resolve(REPO_ROOT, 'e2e', 'screenshots', 'navigation')

export const API_PORT = 5454
export const ADMIN_PORT = 5455
export const API_URL = `http://127.0.0.1:${API_PORT}`
export const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`

// A phone, a tablet and a desktop. `hasTouch` is what turns CDP touch
// dispatch into real TouchEvents, which the edge-swipe case needs.
export const VIEWPORTS = {
  desktop: { hasTouch: false, height: 800, width: 1280 },
  phone: { hasTouch: true, height: 844, width: 390 },
  tablet: { hasTouch: true, height: 1024, width: 768 },
}

// Chromium: an explicit path wins, otherwise playwright-core resolves its
// own download. `playwright install` is never run from the suite.
export const chromiumPath = () => process.env.CHROMIUM_PATH?.trim() || undefined

// `dev` runs the Vite dev server the local loop uses; `preview` serves an
// already-built `admin/dist`, which is what CI does.
export const adminMode = () =>
  (process.env.NAV_E2E_ADMIN_MODE?.trim() === 'preview' ? 'preview' : 'dev')

export const databaseUrl = () => process.env.DATABASE_URL?.trim() ?? ''

export const keepServers = () => process.env.NAV_E2E_KEEP_SERVERS === '1'

export const headed = () => process.env.NAV_E2E_HEADED === '1'
