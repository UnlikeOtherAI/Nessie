import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The two visibility affordances, rendered.
 *
 * A protected room is drawn with a lock, derived from `visibility` because the
 * wire carries no `locked` field; and the composer follows MEMBERSHIP, not the
 * management flag beside it. The case that matters is the third one: an
 * organisation admin who may open a protected room's settings and may not post
 * in it. A unit test can assert those booleans, but only a render proves the
 * screen actually says so — the refusal has to be visible, or a person is left
 * looking at a room with no way to type in it and no reason given.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/project-usability/visibility-affordances')
const affordancesPath = resolve(screenshots, 'lock-and-composer-suppression.png')

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 900, width: 720 } })
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/visibility-affordances/index.html`)
  await page.locator('[data-ready="true"]').waitFor()

  // A member of a public room: writes and manages.
  await assertCase(page, 'member', { join: 'hidden', manage: 'shown', post: 'shown' })

  // Browsing a public room: read-only, and Join is offered rather than a
  // composer that would 403.
  await assertCase(page, 'browsing', { join: 'shown', manage: 'hidden', post: 'hidden' })
  assert.match(
    await page.getByTestId('browsing-refusal').innerText(),
    /Join this channel/,
    'a public room the viewer has not joined says how to get in',
  )

  // The case the two authorities pull apart. Management is not participation:
  // the settings are there, the composer is not, and no Join is offered because
  // a protected room is not self-service.
  await assertCase(page, 'admin-outside', { join: 'hidden', manage: 'shown', post: 'hidden' })
  assert.match(
    await page.getByTestId('admin-outside-refusal').innerText(),
    /not a member of this channel/,
    'an admin outside the room is told why there is no composer',
  )

  // The lock is drawn from `visibility` alone, and only for protected.
  const protectedGlyph = page.getByTestId('case-admin-outside').getByLabel('Protected channel')
  assert.equal(await protectedGlyph.count(), 1, 'a protected room replaces its # with a lock')
  assert.equal(
    await page.getByTestId('case-member').getByLabel('Protected channel').count(),
    0,
    'a public room keeps its #',
  )
  assert.equal(
    await page.getByTestId('project-protected').getByLabel('Protected project').count(),
    1,
    'a protected project is marked',
  )
  assert.equal(
    await page.getByTestId('project-public').getByLabel('Protected project').count(),
    0,
    'a public project carries no marker at all',
  )

  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: affordancesPath })

  await context.close()
  console.log(`Visibility affordance proofs passed: ${affordancesPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}

async function assertCase(page, id, expected) {
  for (const [field, value] of Object.entries(expected)) {
    const text = await page.getByTestId(`${id}-${field}`).innerText()
    assert.match(
      text,
      new RegExp(`${value}$`, 'u'),
      `${id}: ${field} should be ${value}, got "${text}"`,
    )
  }
}
