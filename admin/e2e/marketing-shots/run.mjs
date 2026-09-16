// Re-capture every screenshot the public site uses, from the running product.
//
//   DATABASE_URL=… pnpm --filter @nessie/admin shots
//
// It brings up this checkout's API and admin, seeds the organisation the
// pictures are of, walks `manifest.mjs`, and writes into
// `web/public/screenshots/`. The point of automating it is that the website's
// pictures stop being a thing someone cropped by hand eighteen months ago: a
// UI change that breaks a shot breaks this run, loudly, with the selector that
// no longer matches.
//
// Every element shot is checked by reading its pixels afterwards (alpha.mjs),
// because the transparency is the deliverable and a rendered thumbnail cannot
// show it.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT, databaseUrl } from '../navigation/lib/config.mjs'
import { readBootstrapToken, startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { assertRounded } from './alpha.mjs'
import { FREEZE_CSS, captureElement, captureWindow } from './capture.mjs'
import { seedMarketingOrganisation } from './fixture.mjs'
import { shots } from './manifest.mjs'

const OUT = resolve(REPO_ROOT, 'web', 'public', 'screenshots')
const ADMIN_URL = 'http://127.0.0.1:5455'
const API_URL = 'http://127.0.0.1:5454'

/** Only these are captured, when names are passed on the command line. */
const only = new Set(process.argv.slice(2))

const signIn = async (api) => {
  const bootstrapToken = readBootstrapToken(api)
  const response = await fetch(`${API_URL}/api/auth/${bootstrapToken ? 'bootstrap' : 'dev-login'}`, {
    ...(bootstrapToken
      ? {
        body: JSON.stringify({
          bootstrapToken,
          displayName: 'Ondrej Rafaj',
          email: 'ondrej@nessie.works',
          password: 'marketing-shots-password',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
      : {}),
  })
  const body = await response.json()
  const token = body?.data?.token
  if (!token) throw new Error(`sign-in failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 300)}`)
  return token
}

const run = async () => {
  if (!databaseUrl()) throw new Error('DATABASE_URL is required — these shots are taken of a real, seeded instance')
  await mkdir(OUT, { recursive: true })

  const api = await startApi({ reuseExisting: false })
  let admin = null
  let browser = null
  const taken = []
  const failed = []
  try {
    admin = await startAdmin({ reuseExisting: false })
    const token = await signIn(api)
    // A database restored from `snapshot.sql` already holds the scenes, and
    // re-deriving them would quietly bring them up to today's schema — which
    // is the opposite of what a snapshot is for. `SHOTS_SKIP_SEED=1` takes the
    // database exactly as it is.
    if (process.env.SHOTS_SKIP_SEED === '1') {
      console.log('  seed skipped — capturing the database as restored')
    } else {
      const me = await (await fetch(`${API_URL}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json()
      await seedMarketingOrganisation(databaseUrl(), me.data.user.id)
    }

    browser = await launchBrowser()
    for (const shot of shots) {
      if (only.size > 0 && !only.has(shot.name)) continue
      const context = await browser.newContext({
        // Retina: the site serves these at up to ~1100 CSS pixels wide.
        deviceScaleFactor: 2,
        viewport: shot.viewport,
      })
      await context.addInitScript(([key, value]) => { window.localStorage.setItem(key, value) }, ['nessie.admin.token', token])
      const page = await context.newPage()
      page.setDefaultTimeout(30_000)
      const path = resolve(OUT, `${shot.name}.png`)
      try {
        await page.goto(`${ADMIN_URL}${shot.route()}`, { waitUntil: 'domcontentloaded' })
        // Waiting for the subject of the picture, never for a duration: a
        // timeout that is long enough today photographs a spinner tomorrow.
        await page.locator(shot.ready).first().waitFor({ state: 'visible' })
        if (shot.open) {
          // Not an exact match: a list card truncates its own title, so the
          // visible text is rarely the whole string the manifest names.
          await page.getByText(shot.open, { exact: false }).first().click()
          await page.waitForTimeout(1_200)
        }
        await page.addStyleTag({ content: FREEZE_CSS })
        await page.waitForTimeout(400)
        if (shot.kind === 'window') {
          await captureWindow(page, { hide: shot.hide, path })
        } else {
          const pad = shot.pad ?? 48
          await captureElement(page, {
            hide: shot.hide,
            inset: shot.inset ?? 0,
            pad,
            path,
            radius: shot.radius ?? 20,
            selector: shot.selector,
          })
          assertRounded(path, { pad })
        }
        taken.push(shot.name)
        console.log(`  ok   ${shot.name}  ${shot.claim}`)
      } catch (error) {
        failed.push({ name: shot.name, reason: error instanceof Error ? error.message : String(error) })
        console.log(`  FAIL ${shot.name}  ${error instanceof Error ? error.message.split('\n')[0] : error}`)
      } finally {
        await context.close()
      }
    }

    // A written record of what each file is for, beside the files themselves:
    // the next person to change a claim can see which picture goes with it.
    await writeFile(
      resolve(OUT, 'README.md'),
      [
        '# Screenshots',
        '',
        'Generated — do not edit by hand. Re-take them with:',
        '',
        '```bash',
        'DATABASE_URL=… pnpm --filter @nessie/admin shots',
        '```',
        '',
        'The organisation in these pictures is a fixture (`admin/e2e/marketing-shots/fixture.mjs`).',
        'The people and the company are invented; the product is not.',
        '',
        '| File | Slot | The claim it backs |',
        '|---|---|---|',
        ...shots.map((shot) => `| \`${shot.name}.png\` | ${shot.kind} | ${shot.claim} |`),
        '',
      ].join('\n'),
    )
  } finally {
    await browser?.close().catch(() => {})
    await stopProcess(admin)
    await stopProcess(api)
  }

  console.log(`\n${taken.length}/${shots.length} captured into web/public/screenshots`)
  if (failed.length > 0) {
    console.log(`${failed.length} failed:`)
    for (const entry of failed) console.log(`  ${entry.name}: ${entry.reason.split('\n')[0]}`)
    process.exitCode = 1
  }
}

await run()
