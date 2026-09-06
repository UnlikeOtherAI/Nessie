// The organisation's own colour scheme, end to end
// (docs/plans/2026-09-05-organisation-custom-theme.md §11).
//
// What this proves that a unit test cannot: the derived palette actually
// repaints the real shell — rail, sidebar, header, cards — because the preview
// is the app rather than a miniature; a blocking check leaves the page painted
// in the last valid draft, so an administrator cannot type themselves into a
// screen they can no longer read; the palette survives a reload before any
// network response; and it does NOT reach the signed-out sign-in screen.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { call } from '../navigation/lib/seed.mjs'
import { readBootstrapToken, startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const outDir = resolve(REPO_ROOT, 'e2e/screenshots/organization-theme')
const BRAND = { accent: '#0f766e', surface: '#0b1416' }

const failures = []
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures.push(`${label}: got ${actual}, expected ${expected}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${actual}, expected ${expected}`}`)
}

// The colour tokens are registered with `@property … syntax: '<color>'`, so a
// computed read is always `rgb(...)`, never the authored hex.
const toHex = (value) => {
  const parts = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(value)
  if (!parts) return value
  return `#${parts.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`
}

const themeState = async (page) => {
  const raw = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      accent: styles.getPropertyValue('--accent').trim(),
      dataTheme: document.documentElement.dataset.theme,
      rail: styles.getPropertyValue('--rail').trim(),
      styleBlock: Boolean(document.getElementById('nessie-organization-theme')),
    }
  })
  return { ...raw, accent: toHex(raw.accent), rail: toHex(raw.rail) }
}

const goto = async (page, path) => {
  await page.goto(`${ADMIN_URL}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
}

const setColour = async (page, label, hex) => {
  const field = page.getByLabel(`${label} hex value`)
  await field.fill(hex)
  await field.blur()
  await page.waitForTimeout(500)
}

const signIn = async (apiServer) => {
  const bootstrapToken = readBootstrapToken(apiServer)
  if (bootstrapToken) {
    const result = await call('/api/auth/bootstrap', {
      body: {
        bootstrapToken,
        displayName: 'Organisation Theme E2E',
        email: 'organization-theme-e2e@example.com',
        password: 'organization-theme-e2e-password',
      },
      method: 'POST',
    })
    return result.token
  }
  return (await call('/api/auth/dev-login')).token
}

const api = await startApi()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const token = await signIn(api)
  // Start from "this organisation has never had a palette", so the run asserts
  // the empty state and a first save rather than whatever a previous run left.
  await call('/api/organizations/current', { body: { theme: null }, method: 'PATCH', token })

  const context = await browser.newContext({ viewport: { height: 900, width: 1440 } })
  await context.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value) },
    ['nessie.admin.token', token],
  )
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on('pageerror', (error) => failures.push(`page error: ${String(error)}`))
  await mkdir(outDir, { recursive: true })
  const shot = (name) => page.screenshot({ path: resolve(outDir, `${name}.png`) })

  console.log('no palette yet')
  await goto(page, '/settings/organization?tab=appearance')
  await shot('01-empty')
  check('the Appearance tab is on the organisation screen',
    (await page.locator('[role="tablist"] >> text=Appearance').count()) > 0, true)
  check('nothing to remove', await page.locator('button:has-text("Remove theme")').count(), 0)
  check('nothing to reset', await page.locator('text=Reset to saved').count(), 0)

  console.log('a dark brand draft repaints the real shell')
  await page.locator('[role="radiogroup"] >> text=Dark').click()
  await page.waitForTimeout(400)
  await setColour(page, 'Accent', BRAND.accent)
  await setColour(page, 'Background', BRAND.surface)
  await shot('02-draft-dark')
  let state = await themeState(page)
  check('data-theme', state.dataTheme, 'organization')
  check('the accent is the brand’s, verbatim', state.accent, BRAND.accent)
  check('the rail is derived from it', state.rail, '#021b19')
  check('one style block carries the palette', state.styleBlock, true)

  console.log('a palette whose accent cannot be seen is refused')
  await setColour(page, 'Accent', '#1f2937')
  await shot('03-blocked')
  check('Save is disabled', await page.locator('button:has-text("Save theme")').first().isDisabled(), true)
  check('the reason is on screen', (await page.locator('text=/needs 3:1/').count()) > 0, true)
  state = await themeState(page)
  check('the page still reads, in the last valid draft', state.accent, BRAND.accent)

  console.log('saving makes it the organisation’s default')
  await setColour(page, 'Accent', BRAND.accent)
  await page.locator('button:has-text("Save theme")').first().click()
  await page.waitForTimeout(1500)
  await shot('04-saved')
  check('saved', (await page.locator('text=/Theme saved/').count()) > 0, true)
  check('Remove is now offered', (await page.locator('button:has-text("Remove theme")').count()) > 0, true)

  console.log('a reload paints it before the API answers')
  await page.route('**/api/organizations/current', async (route) => {
    await new Promise((settle) => { setTimeout(settle, 4000) })
    await route.continue()
  })
  await page.goto(`${ADMIN_URL}/settings/organization?tab=appearance`, { waitUntil: 'commit' })
  await page.waitForTimeout(700)
  state = await themeState(page)
  check('painted from the first-paint cache', state.dataTheme, 'organization')
  check('with the saved accent', state.accent, BRAND.accent)
  await page.unroute('**/api/organizations/current')

  console.log('the member doorway')
  await goto(page, '/settings/account?tab=appearance')
  await shot('05-colours-panel')
  const cards = await page.locator('fieldset label').allInnerTexts()
  check('the organisation card comes first', (cards[0] ?? '').includes('Default'), true)
  check('an administrator is offered the way in',
    (await page.locator("text=Edit your organisation's theme").count()) > 0, true)

  console.log('a person keeps the last word')
  await page.locator('fieldset label:has-text("Forest")').click()
  await page.waitForTimeout(1200)
  state = await themeState(page)
  check('a built-in beats the organisation default', state.dataTheme, 'forest')
  check('and paints its own accent', state.accent, '#047857')
  await page.locator('fieldset label').first().click()
  await page.waitForTimeout(1200)
  state = await themeState(page)
  check('choosing the organisation card comes back', state.dataTheme, 'organization')

  console.log('the palette is tenant state and stops at the door')
  // A real sign-out, and deliberately no navigation afterwards: the context
  // re-plants the session token on every load, and the claim under test is
  // that signing out itself takes the palette down.
  await goto(page, '/channels')
  await page.getByLabel('Account menu').first().click()
  await page.waitForTimeout(800)
  await page.locator('text=Log out').first().click()
  await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 })
  await page.waitForTimeout(2000)
  await shot('06-login')
  state = await themeState(page)
  check('no organisation palette on the sign-in screen', state.dataTheme === 'organization', false)
  check('and no style block left behind', state.styleBlock, false)

  await context.close()
  console.log(`\nScreenshots in ${outDir}`)
  if (failures.length > 0) {
    throw new Error(`organisation theme e2e failed:\n  ${failures.join('\n  ')}`)
  }
  console.log('organisation theme e2e: all checks passed')
} finally {
  await browser.close()
  await stopProcess(admin)
  await stopProcess(api)
}
