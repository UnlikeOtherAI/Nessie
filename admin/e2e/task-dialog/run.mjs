import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The ticket dialog, rendered (docs/plans/2026-09-21-ticket-comments-
 * attachments-labels/delivery.md §6.5).
 *
 * A pure fixture over a stubbed ApiClient: the real TaskDialog, KanbanCard and
 * Board → Settings → Labels, no database. What it pins is geometry and
 * behaviour a unit test cannot see — Documents sitting directly under the
 * description in the left column rather than under the whole grid, the Labels
 * field staying a compact growing field instead of a wall of every label, the
 * token field's keys, the three read-only states, the phone's stacked order,
 * a label list that is the ticket's board's and no other's, and a file removed
 * with a reason that stays on the ticket (board-labels-and-attachment-
 * removal.md §10.5) — and every state is screenshotted under
 * e2e/screenshots/task-dialog/.
 */

const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/task-dialog')
const shot = (name) => resolve(SHOTS, name)

// A 320×180 gradient PNG, so a resolved description image is visibly an image.
const png = (() => {
  const width = 320
  const height = 180
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = 40 + Math.round((x / width) * 160)
      row[2 + x * 3] = 80 + Math.round((y / height) * 120)
      row[3 + x * 3] = 200
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
})()

const uploads = { hold: false, count: 0 }

const PROJECT = '10000000-0000-4000-8000-000000000002'
const BOARD = '10000000-0000-4000-8000-000000000003'
const PERSON = '20000000-0000-4000-8000-000000000001'
const IMAGE_ID = '40000000-0000-4000-8000-000000000001'
const REMOVED_ID = '40000000-0000-4000-8000-000000000005'

// The settings scenario stores a token so the session restores as an owner;
// every other scenario has none and stays signed out, as it always has.
const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
  context: { bootstrapMode: false, channelId: null, organizationId: '10000000-0000-4000-8000-000000000001', projectId: null, teamId: null },
  session: { issuedAt: '2026-09-20T09:00:00.000Z', sessionId: '90000000-0000-4000-8000-000000000001' },
  user: { displayName: 'Ondřej Rafaj', email: 'ondrej@example.test', id: PERSON, roleIds: ['owner'] },
}

/** Bytes leave through fetch/XHR, not the ApiClient: answer them here. */
const routeBytes = async (context) => {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me') {
      if (!route.request().headers().authorization) {
        await route.fulfill({ body: '{"error":{"message":"signed out"}}', contentType: 'application/json', status: 401 })
      } else {
        await route.fulfill({ body: JSON.stringify({ data: me }), contentType: 'application/json', status: 200 })
      }
      return
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      await route.fulfill({ body: png, contentType: 'image/png', status: 200 })
      return
    }
    if (url.pathname === '/api/uploads') {
      if (uploads.hold) return // never answered: the upload stays in flight
      uploads.count += 1
      const id = `80000000-0000-4000-8000-${String(uploads.count).padStart(12, '0')}`
      await route.fulfill({
        body: JSON.stringify({ data: {
          createdAt: new Date().toISOString(), filename: 'notes.txt', id, kind: 'file', mime: 'text/plain',
          organizationId: '10000000-0000-4000-8000-000000000001', sizeBytes: '12',
        } }),
        contentType: 'application/json',
        status: 201,
      })
      return
    }
    await route.fulfill({ body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json', status: 404 })
  })
}

const open = async (context, query) => {
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/task-dialog/index.html?${query}`)
  await page.locator('[data-ready="true"]').waitFor()
  return page
}

const box = async (locator) => {
  const found = await locator.boundingBox()
  assert.ok(found, 'element is laid out')
  return found
}

const pillNames = (dialog) =>
  dialog.locator('.admin-token-input').first().locator('.admin-label-pill-name').allInnerTexts()

/** Screenshots wait for overlay motion to finish: a mid-fade popover is invisible in a still. */
const settled = async (page) => {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  await page.waitForTimeout(150)
}

const calls = (page) => page.evaluate(() => window.taskDialogCalls)

/**
 * A removed file (§9.6): dimmed, the `Removed` pill, the second line naming
 * who removed it, when and why — and Download still offered, Remove not.
 */
const assertRemovedRow = async (attachments, { byName, id = REMOVED_ID, reason }) => {
  const row = attachments.locator(`li[data-attachment-id="${id}"]`)
  assert.equal(await row.getAttribute('data-attachment-removed'), 'true')
  await row.getByText('Removed', { exact: true }).waitFor()
  const line = row.getByTestId('attachment-removal')
  await line.getByText(byName, { exact: true }).waitFor()
  const text = (await line.innerText()).replace(/\s+/g, ' ').trim()
  assert.match(text, /^Removed by .+?\s*·\s*(just now|\d+ (min|h|d) ago)/u, text)
  await line.getByText(reason, { exact: true }).waitFor()
  const filename = await row.locator('.task-attachment-name').innerText()
  assert.equal(await row.getByRole('button', { name: `Download ${filename}` }).count(), 1, 'a removed file still downloads')
  assert.equal(await row.getByRole('button', { name: `Remove ${filename}` }).count(), 0, 'and is not removed twice')
  const opacity = await row.locator('.task-attachment-name').evaluate((node) => Number(getComputedStyle(node).opacity))
  assert.ok(opacity < 0.75, `the removed name is dimmed (${opacity})`)
  const decoration = await row.locator('.task-attachment-name').evaluate((node) => getComputedStyle(node).textDecorationLine)
  assert.equal(decoration, 'none', 'never struck through')
  return row
}

/** The z-index an overlay's scrim computes: the scrim is its panel's parent. */
const scrimLayer = (panel) => panel.evaluate((node) => getComputedStyle(node.parentElement).zIndex)

/**
 * The full-size viewer opened from inside the ticket dialog is the sanctioned
 * `blocking` nesting (docs/navigation/overlays.md §7): it paints above the
 * dialog and owns Back, so Back closes the viewer and leaves the ticket open.
 * As a second `modal` it tied with the dialog on layer and Back priority, and
 * the registry's stable sort gave Back to the first registered — the dialog —
 * closing the ticket beneath a viewer left open over nothing.
 */
const assertViewerOwnsBack = async (page, opener, { label, screenshot }) => {
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  await opener.click()
  const viewer = page.getByTestId('attachment-viewer')
  await viewer.waitFor()
  assert.equal(await scrimLayer(viewer), '80', `${label}: the viewer's scrim is on the blocking layer`)
  assert.equal(await scrimLayer(dialog), '70', `${label}: the ticket dialog stays on the modal layer beneath`)
  assert.equal(
    await page.evaluate(() => window.taskDialogBack.active()),
    'overlay:attachment-viewer',
    `${label}: Back belongs to the viewer while it is open`,
  )
  if (screenshot) {
    await settled(page)
    await page.screenshot({ path: shot(screenshot) })
  }
  assert.equal(await page.evaluate(() => window.taskDialogBack.press()), 'overlay:attachment-viewer')
  await viewer.waitFor({ state: 'detached' })
  assert.ok(await dialog.isVisible(), `${label}: Back closed the viewer and left the ticket dialog open`)
  const owner = await page.evaluate(() => window.taskDialogBack.active())
  assert.ok(owner?.startsWith('overlay:') && owner !== 'overlay:attachment-viewer',
    `${label}: the ticket dialog owns Back again (${owner})`)
}

const assertDetails = async (page) => {
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  await dialog.waitFor()
  const description = dialog.getByTestId('task-description-read')
  await description.getByRole('heading', { name: 'Checkout slows down on large carts' }).waitFor()
  assert.equal(await description.getByRole('listitem').count(), 3, 'the description list rendered')
  await description.locator('img[src^="blob:"]').waitFor({ timeout: 10_000 })

  // Documents directly under the description, in the LEFT column — not under
  // the whole grid, which is where it sat and why labels pushed it down.
  const head = await box(dialog.locator('.task-dialog-head'))
  const meta = await box(dialog.locator('.task-dialog-meta'))
  const descriptionBox = await box(description)
  const documents = await box(dialog.getByTestId('task-documents'))
  const attachmentsBox = await box(dialog.getByTestId('task-attachments'))
  const commentsBox = await box(dialog.getByTestId('task-comments'))
  assert.ok(meta.x > head.x + head.width - 1, 'meta is the right column')
  assert.ok(Math.abs(documents.x - head.x) < 2, 'Documents is in the left column')
  assert.ok(documents.y >= descriptionBox.y + descriptionBox.height, 'Documents follows the description')
  assert.ok(documents.y - (descriptionBox.y + descriptionBox.height) < 40, 'Documents sits directly under it')
  assert.ok(attachmentsBox.y > documents.y && commentsBox.y > attachmentsBox.y, 'then Attachments, then Comments')
  assert.ok(documents.y < meta.y + meta.height, 'Documents starts beside the meta column, not below it')

  // Labels: four pills in one compact field, not a wall of every label.
  assert.deepEqual(await pillNames(dialog), ['Bug', 'Frontend', 'Performance', 'Design'])
  const field = await box(dialog.locator('.admin-token-input').first())
  assert.ok(field.height < 110, `the labels field stays compact (${field.height}px)`)
  assert.equal(await page.getByRole('listbox', { name: 'Labels' }).count(), 0, 'no label list until the field is used')

  const attachments = dialog.getByTestId('task-attachments')
  assert.equal(await attachments.locator('li[data-attachment-id]').count(), 4)
  await attachments.getByText('in description').waitFor()
  await attachments.getByText('Checkout redesign — Figma').waitFor()
  await attachments.getByText("Couldn't copy from Linear").waitFor()
  assert.equal(await attachments.getByRole('link', { name: 'Open in Linear ↗' }).count(), 1)
  await assertRemovedRow(attachments, { byName: 'Jana Nováková', reason: '“Superseded by v2”' })
  // The header counts live rows, then the removed ones.
  await attachments.getByText('Attachments · 3 · 1 removed').waitFor()

  const comments = dialog.getByTestId('task-comments')
  assert.equal(await comments.locator('li[data-comment-id]').count(), 3)
  await comments.getByText('Petr Linear').waitFor()
  await comments.getByText('Perf agent').waitFor()
  await comments.getByText('Ondřej Rafaj', { exact: true }).waitFor()
  assert.equal(await comments.getByText('Nessie only').count(), 2, 'the agent and own comments stayed in Nessie')
  assert.equal(await comments.getByRole('button', { name: 'Comment actions' }).count(), 1, 'only the own comment')
  await comments.getByText('Comments post to Linear as Ondřej Rafaj.').waitFor()
  return dialog
}

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  await mkdir(SHOTS, { recursive: true })
  const desktop = await browser.newContext({ viewport: { height: 1100, width: 1440 } })
  await routeBytes(desktop)

  // 01 — the details layout, in the dark default and in daylight.
  for (const [theme, name] of [[null, '01-details-desktop.png'], ['daylight', '01-details-desktop-light.png']]) {
    const page = await open(desktop, `scenario=details${theme ? `&theme=${theme}` : ''}`)
    await assertDetails(page)
    // Tall enough that the whole dialog — comments included — is in frame.
    await page.setViewportSize({ height: 2000, width: 1440 })
    await page.getByRole('dialog', { name: 'Task details' }).getByTestId('task-comment-composer').waitFor()
    await settled(page)
    await page.screenshot({ path: shot(name) })
    await page.close()
  }

  // Comments and attachments are immediate: post, upload, and see both land.
  {
    const page = await open(desktop, 'scenario=details')
    const dialog = await assertDetails(page)
    const composer = dialog.getByRole('textbox', { name: 'Comment' })
    await composer.click()
    await composer.pressSequentially('Shipped the memo fix.')
    await page.keyboard.press('Control+Enter')
    await dialog.getByText('Shipped the memo fix.').waitFor()
    const posted = (await calls(page)).find((call) => call.method === 'POST' && call.path.endsWith('/comments'))
    assert.equal(posted?.body?.body, 'Shipped the memo fix.')
    assert.equal(await composer.innerText().then((text) => text.trim()), '', 'the composer cleared')

    await dialog.getByTestId('task-attachments-input').setInputFiles({
      buffer: Buffer.from('profiling notes'), mimeType: 'text/plain', name: 'notes.txt',
    })
    await dialog.getByTestId('task-attachments').locator('li[data-attachment-id]').nth(4).waitFor()
    const linked = (await calls(page)).find((call) => call.method === 'POST' && call.path.endsWith('/attachments'))
    assert.equal(linked?.body?.attachmentIds?.length, 1, 'the upload was linked to the ticket at once')
    await page.close()
  }

  // 02 — the description editor, with an image still uploading.
  {
    const page = await open(desktop, 'scenario=details')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('button', { name: 'Edit description' }).click()
    const editor = dialog.getByRole('textbox', { name: 'Description' })
    await editor.waitFor()
    // The description's editor comes first; the comment composer carries its own.
    const descriptionEditor = dialog.locator('.admin-markdown-editor').first()
    await descriptionEditor.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Image' }).waitFor()
    await dialog.getByRole('button', { name: 'Done' }).waitFor()
    uploads.hold = true
    await descriptionEditor.getByTestId('markdown-editor-image-input').setInputFiles({
      buffer: png, mimeType: 'image/png', name: 'flamegraph.png',
    })
    await descriptionEditor.locator('[data-uploading="true"]').waitFor()
    await settled(page)
    await page.screenshot({ path: shot('02-description-editing.png') })
    uploads.hold = false
    // Done returns to the rendered draft; nothing is saved until Save changes.
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Draft line.')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await dialog.getByTestId('task-description-read').getByText('Draft line.').waitFor()
    assert.equal((await calls(page)).filter((call) => call.method === 'PATCH').length, 0)
    await page.close()
  }

  // 03, 04, 05 — the token field.
  {
    const page = await open(desktop, 'scenario=details')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByTestId('task-description-read').locator('img[src^="blob:"]').waitFor()
    const input = dialog.getByRole('combobox', { name: 'Labels' })
    await input.focus()
    const list = page.getByRole('listbox', { name: 'Labels' })
    await list.waitFor()
    const options = list.getByRole('option')
    assert.equal(await options.count(), 7, "every label of the ticket's board is listed")
    assert.equal(await list.getByText('Research', { exact: true }).count(), 0, "another board's labels are not")
    assert.ok(
      (await calls(page)).some((call) => call.method === 'GET' && call.path === `/api/projects/${PROJECT}/boards/${BOARD}/labels`),
      "the field reads the board's labels",
    )
    for (let index = 0; index < 4; index += 1) {
      assert.equal(await options.nth(index).getAttribute('aria-selected'), 'true', 'chosen labels come first')
    }
    const manage = page.getByRole('link', { name: 'Manage labels…' })
    assert.equal(await manage.getAttribute('href'), `/projects/${PROJECT}/boards/${BOARD}/settings?tab=labels`)
    await settled(page)
    await page.screenshot({ path: shot('03-labels-open.png') })

    await input.pressSequentially('perf')
    assert.equal(await options.count(), 2, 'one match and the create row')
    await list.getByRole('option', { name: 'Create label “perf”' }).waitFor()
    await settled(page)
    await page.screenshot({ path: shot('04-labels-filtered-create.png') })
    // Enter with no active row and no exact match creates it, and keeps focus.
    await page.keyboard.press('Enter')
    await dialog.locator('.admin-token-input').first().getByText('perf', { exact: true }).waitFor()
    const created = (await calls(page)).find((call) => call.method === 'POST' && call.path.endsWith('/labels'))
    assert.equal(created?.path, `/api/projects/${PROJECT}/boards/${BOARD}/labels`, "created on the ticket's board")
    assert.equal(created?.body?.name, 'perf')
    assert.match(String(created?.body?.color), /^#[0-9a-f]{6}$/)
    assert.equal(await input.inputValue(), '', 'the text cleared')
    assert.ok(await input.evaluate((node) => node === document.activeElement), 'focus stays in the field')
    await page.close()
  }
  {
    const page = await open(desktop, 'scenario=details')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    const input = dialog.getByRole('combobox', { name: 'Labels' })
    await input.focus()
    await page.getByRole('listbox', { name: 'Labels' }).waitFor()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Backspace')
    assert.equal(await dialog.locator('.admin-token-input-token[data-highlighted="true"]').count(), 1)
    await page.keyboard.press('Backspace')
    assert.deepEqual(await pillNames(dialog), ['Bug', 'Performance'])
    await settled(page)
    await page.screenshot({ path: shot('05-labels-keyboard.png') })
    // Escape closes the list and leaves the dialog open.
    await page.keyboard.press('Escape')
    await page.getByRole('listbox', { name: 'Labels' }).waitFor({ state: 'hidden' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForFunction(() => window.taskDialogCalls.some((call) => call.method === 'PATCH'))
    const saved = (await calls(page)).find((call) => call.method === 'PATCH')
    assert.deepEqual(saved.body.labelIds, [
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000003',
    ], 'labelIds ride the save')
    await page.close()
  }

  // 06 — mirrored read-only: the source's labels are locked, Nessie's are not.
  {
    const page = await open(desktop, 'scenario=mirrored-readonly')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByText(/Linear owns its status, assignee and\s+title here/).waitFor()
    const field = dialog.locator('.admin-token-input').first()
    await field.getByText('Bug', { exact: true }).waitFor()
    assert.equal(await field.getByRole('button', { name: 'Remove Bug' }).count(), 0, 'a source-owned pill is locked')
    assert.equal(await field.getByRole('button', { name: 'Remove Performance' }).count(), 1, 'a Nessie-only pill is not')
    assert.equal(await field.locator('[title="Linear owns this label"]').count(), 2)
    await dialog.getByText('This ticket mirrors Linear read-only. Comments stay in Nessie.').waitFor()
    await page.setViewportSize({ height: 2000, width: 1440 })
    await settled(page)
    await page.screenshot({ path: shot('06-mirrored-readonly.png') })
    await page.close()
  }

  // 07 — a viewer who may read the ticket and not change it.
  {
    const page = await open(desktop, 'scenario=viewer')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByTestId('task-description-read').getByRole('heading').first().waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Edit description' }).count(), 0, 'no pencil')
    assert.equal(await dialog.getByRole('textbox', { name: 'Comment' }).count(), 0, 'no composer')
    assert.equal(await dialog.getByTestId('task-attachments').getByRole('button', { name: 'Upload file' }).count(), 0)
    assert.equal(await dialog.getByRole('button', { name: /^Remove / }).count(), 0, 'nothing removable')
    await assertRemovedRow(dialog.getByTestId('task-attachments'), { byName: 'Jana Nováková', reason: '“Superseded by v2”' })
    assert.equal(await dialog.getByRole('button', { name: 'New note' }).count(), 0, 'no document creation')
    assert.equal(await dialog.getByRole('button', { name: 'Comment actions' }).count(), 0)
    assert.ok(await dialog.getByRole('combobox', { name: 'Labels' }).isDisabled(), 'labels are read-only')
    await dialog.getByText('You can read this ticket but not comment on it.').waitFor()
    await page.setViewportSize({ height: 2000, width: 1440 })
    await settled(page)
    await page.screenshot({ path: shot('07-viewer-readonly.png') })
    await page.close()
  }

  // Create mode: the editor is open with no toggle, and the body holds it alone.
  {
    const page = await open(desktop, 'scenario=create')
    const dialog = page.getByRole('dialog', { name: 'New task' })
    await dialog.getByRole('textbox', { name: 'Description' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Edit description' }).count(), 0)
    assert.equal(await dialog.getByTestId('task-comments').count(), 0)
    assert.equal(await dialog.getByTestId('task-attachments').count(), 0)
    await page.close()
  }

  // 12, 13 — removing a file asks why, and the row stays, saying so.
  {
    const page = await open(desktop, 'scenario=details')
    const dialog = await assertDetails(page)
    const attachments = dialog.getByTestId('task-attachments')
    await attachments.getByRole('button', { name: 'Remove profile.png' }).click()
    const confirm = page.getByRole('dialog', { name: 'Remove “profile.png”?' })
    await confirm.getByText('It stays on the ticket, marked as removed by you, and can still be downloaded.').waitFor()
    await confirm.getByText('It is shown in the description and keeps rendering there.').waitFor()
    await confirm.getByText('Optional — why it is being removed').waitFor()
    const reasonBox = confirm.getByRole('textbox', { name: 'Reason' })
    assert.ok(await reasonBox.evaluate((node) => node === document.activeElement), 'the reason has focus')
    const reasonText = 'Replaced by a sharper profile capture'
    await reasonBox.pressSequentially(reasonText)
    assert.equal(await confirm.getByTestId('remove-attachment-reason-count').innerText(), `${reasonText.length}/500`)
    assert.equal(await reasonBox.getAttribute('maxlength'), '500')
    // Enter is a newline, not a submit: the dialog stays open.
    await page.keyboard.press('Enter')
    assert.equal(await reasonBox.inputValue(), `${reasonText}\n`)
    await page.keyboard.press('Backspace')
    assert.equal((await calls(page)).filter((call) => call.method === 'DELETE').length, 0)
    await settled(page)
    await page.screenshot({ path: shot('12-remove-confirm.png') })

    // ⌘/Ctrl+Enter removes.
    await page.keyboard.press('Control+Enter')
    await confirm.waitFor({ state: 'hidden' })
    const removed = (await calls(page)).find((call) => call.method === 'DELETE')
    assert.equal(removed?.path, `/api/tasks/10000000-0000-4000-8000-000000000006/attachments/${IMAGE_ID}`)
    assert.deepEqual(removed?.body, { reason: reasonText }, 'the DELETE carries the reason')
    await assertRemovedRow(attachments, { byName: 'Ondřej Rafaj', id: IMAGE_ID, reason: `“${reasonText}”` })
    await attachments.getByText('Attachments · 2 · 2 removed').waitFor()
    // The bytes are still there, so the description keeps rendering the image.
    await dialog.getByTestId('task-description-read').locator('img[src^="blob:"]').waitFor()
    await attachments.scrollIntoViewIfNeeded()
    // No row under the pointer: a hover wash would read as a second state.
    await page.mouse.move(0, 0)
    await settled(page)
    await attachments.screenshot({ path: shot('13-attachment-removed.png') })
    await page.close()
  }

  // 14 — The full-size viewer over the ticket: from the Attachments list and
  // from a comment's files, it owns Back and the ticket stays open under it.
  {
    const page = await open(desktop, 'scenario=viewer-back')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByTestId('task-attachments').locator('li[data-attachment-id]').first().waitFor()
    await assertViewerOwnsBack(page, dialog.getByTestId('task-attachments').locator(`li[data-attachment-id="${IMAGE_ID}"] button`).first(), {
      label: 'attachments list',
      screenshot: '14-viewer-over-ticket.png',
    })
    const commentFile = dialog.getByRole('button', { name: 'View render-trace.png' })
    await commentFile.scrollIntoViewIfNeeded()
    await assertViewerOwnsBack(page, commentFile, { label: "a comment's file" })
    await page.close()
  }

  // 10 — Board → Settings → Labels: rename in progress, the colour popover open.
  {
    const page = await open(desktop, 'scenario=settings')
    const tabs = page.getByRole('tablist', { name: 'Board settings' })
    await tabs.waitFor()
    assert.deepEqual(await tabs.getByRole('tab').allInnerTexts(), ['General', 'Columns', 'Watchers', 'Labels'])
    assert.equal(await tabs.getByRole('tab', { name: 'Labels' }).getAttribute('aria-selected'), 'true')
    await page.getByText('Labels belong to this board. A ticket moved to another board keeps its labels by name.').waitFor()
    await page.getByText('12 tickets').waitFor()
    // This board's labels only: the other board's are not in its settings.
    assert.equal(await page.getByText('Research', { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Delete Bug' }).click()
    await page.getByRole('dialog', { name: 'Delete “Bug”?' }).getByText('It comes off 12 tickets.').waitFor()
    await page.getByRole('button', { name: 'Cancel' }).click()
    // A source-owned label: the name is locked, the colour is not.
    assert.equal(await page.getByRole('button', { name: 'Rename Bug' }).count(), 0)
    await page.getByText('Linear owns the name; colour is yours.').first().waitFor()
    assert.ok(await page.getByRole('button', { name: /Colour of Bug/ }).isEnabled())
    await page.getByRole('button', { name: 'Rename Performance' }).click()
    const nameInput = page.getByRole('textbox', { name: 'Name of Performance' })
    await nameInput.fill('Perf')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.taskDialogCalls.some((call) => call.method === 'PATCH'))
    const renamed = (await calls(page)).find((call) => call.method === 'PATCH')
    assert.deepEqual(renamed.body, { name: 'Perf' })
    assert.equal(renamed.path, `/api/projects/${PROJECT}/boards/${BOARD}/labels/50000000-0000-4000-8000-000000000003`)
    await page.getByRole('button', { name: 'Rename Design' }).click()
    await page.getByRole('textbox', { name: 'Name of Design' }).fill('Design syst')
    await page.getByRole('button', { name: /Colour of Backend/ }).click()
    await page.getByRole('dialog', { name: /Colour of Backend/ }).waitFor()
    await settled(page)
    await page.screenshot({ path: shot('10-labels-settings.png') })
    await page.close()
  }

  // 11 — a card: three label pills, +1, the comment and paperclip counts.
  // Three stored files, one removed: the paperclip counts the two live ones.
  {
    const page = await open(desktop, 'scenario=card')
    const card = page.locator('[data-kanban-card]')
    await card.waitFor()
    assert.equal(await card.locator('.admin-label-pill').count(), 3)
    await card.getByText('+1', { exact: true }).waitFor()
    await card.locator('[title="4 comments"]').waitFor()
    await card.locator('[title="2 files"]').waitFor()
    assert.equal(await card.locator('[title="3 files"]').count(), 0, 'the removed file is not counted')
    await settled(page)
    await card.screenshot({ path: shot('11-card.png') })
    await page.close()
  }

  // 16, 17 — an agent's work on the ticket (docs/standards/ticket-work.md →
  // "What the project sees"): the chip in each state T1 reaches, with the work
  // thread linked only for a reader who may open it, a move that started
  // nothing said on the ticket, and the card's avatar with its state dot.
  {
    const CHIP_STATES = [
      ['active', 'active', /^Perf agent · working · started /, /Last woken .+: a comment · wake 3 of 30/, true],
      ['nolink', 'active', /^Perf agent · working · started /, /Last woken .+: a comment/, false],
      ['parked', 'parked', /^Perf agent · parked · /, /Parked while the ticket is in review\./, true],
      // The ticket sits in a start-work column; the chip must not say moving it back resumes it.
      ['reentry', 'parked', /^Perf agent · parked · /,
        /Moved back by an agent, so work did not resume\. A person who can edit the board can resume it\./, true],
      ['stopped', 'failed', /^Perf agent · stopped · /,
        /Stopped: 30 wakes used\. Move the ticket out of and back into a start-work column to continue\./, true],
      ['done', 'done', /^Perf agent · done · /, /The ticket left the flow/, true],
    ]
    for (const [state, status, headline, line, linked] of CHIP_STATES) {
      const page = await open(desktop, `scenario=details&work=${state}`)
      const dialog = page.getByRole('dialog', { name: 'Task details' })
      const chip = dialog.getByTestId('ticket-work-chip')
      await chip.waitFor()
      assert.equal(await chip.getAttribute('data-work-status'), status, state)
      const text = await chip.innerText()
      assert.match(await chip.getByTestId('ticket-work-headline').innerText(), headline, `${state}: ${text}`)
      assert.match(text, line, `${state}: ${text}`)
      assert.match(text, /Started by Ondřej Rafaj/, state)
      assert.doesNotMatch(text, /machine|executor|PC|Mac/i, `${state}: the chip names no machine`)
      const link = chip.getByRole('link', { name: 'Open the work thread' })
      assert.equal(await link.count(), linked ? 1 : 0, `${state}: the thread link is only for its readers`)
      if (linked) {
        assert.equal(await link.getAttribute('href'),
          '/channels/70000000-0000-4000-8000-000000000011/threads/70000000-0000-4000-8000-000000000012')
      }
      // At the head of the meta column, above the ticket's own fields. Both
      // boxes come from one layout, once the dialog has come to rest: it
      // opens with a 4 px rise, so two separate reads on a slow machine can
      // straddle it and disagree by the whole rise with the chip in place.
      await settled(page)
      const offset = await dialog.evaluate((root) => {
        const meta = root.querySelector('.task-dialog-meta')?.getBoundingClientRect()
        const own = root.querySelector('[data-testid="ticket-work-chip"]')?.getBoundingClientRect()
        return meta && own ? { x: own.x - meta.x, y: own.y - meta.y } : null
      })
      assert.ok(offset, `${state}: the chip and the meta column are both laid out`)
      assert.ok(Math.abs(offset.y) < 4 && Math.abs(offset.x) < 4, `${state}: the chip leads the meta column`)
      if (state === 'reentry') {
        assert.doesNotMatch(text, /Moving it back into a start-work column resumes it/, 'a false remedy')
        assert.equal(await dialog.getByTestId('ticket-work-skip').count(), 0, 'said once, on the work\'s own row')
      }
      await settled(page)
      await chip.screenshot({ path: shot(`16-work-${state}.png`) })
      if (state === 'active') {
        await page.screenshot({ path: shot('16-work-dialog.png') })
        // The ticket's work history: each start, park and resume, and who caused it.
        const history = dialog.getByTestId('ticket-work-history')
        assert.match(await history.locator('summary').innerText(), /^Work history \(3\)$/)
        await history.locator('summary').click()
        const rows = await history.locator('li').allInnerTexts()
        assert.equal(rows.length, 3)
        assert.match(rows[0], /Perf agent resumed the work · by Ondřej Rafaj$/)
        assert.match(rows[1], /Perf agent parked the work while the ticket is in review · by Perf agent$/)
        assert.match(rows[2], /Perf agent started work · by Ondřej Rafaj$/)
        await settled(page)
        await dialog.locator('section[aria-label="Agent work on this ticket"]').screenshot({ path: shot('16-work-history.png') })
      }
      await page.close()
    }

    const page = await open(desktop, 'scenario=details&work=skipped')
    const skip = page.getByTestId('ticket-work-skip')
    await skip.waitFor()
    assert.equal(
      (await skip.innerText()).trim(),
      'Perf agent: Moved by an agent, so work did not start. A person who can edit the board can start it.',
    )
    assert.equal(await page.getByTestId('ticket-work-chip').count(), 0, 'no work, so no chip, only the reason')
    await settled(page)
    await skip.screenshot({ path: shot('16-work-skipped.png') })
    await page.close()

    for (const [state, status, label] of [
      ['active', 'active', 'Perf agent · working'],
      ['stopped', 'failed', 'Perf agent · stopped — its wakes are used up'],
    ]) {
      const cardPage = await open(desktop, `scenario=card&work=${state}`)
      const card = cardPage.locator('[data-kanban-card]')
      const dot = card.getByTestId('ticket-work-card-dot')
      await dot.waitFor()
      assert.equal(await dot.getAttribute('data-work-status'), status)
      assert.equal(await dot.getAttribute('aria-label'), label)
      await settled(cardPage)
      await card.screenshot({ path: shot(`17-card-work-${state}.png`) })
      await cardPage.close()
    }
  }
  await desktop.close()

  // 08, 09 — the phone: stacked in DOM order, the popover below the field.
  const phone = await browser.newContext({
    hasTouch: true, isMobile: true, viewport: { height: 812, width: 375 },
  })
  await routeBytes(phone)
  {
    const page = await open(phone, 'scenario=details')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByTestId('task-description-read').getByRole('heading').first().waitFor()
    const panel = await box(dialog)
    assert.ok(panel.width >= 330, `the dialog uses the phone's width (${panel.width}px)`)
    const head = await box(dialog.locator('.task-dialog-head'))
    const meta = await box(dialog.locator('.task-dialog-meta'))
    const body = await box(dialog.locator('.task-dialog-body'))
    assert.ok(head.y < meta.y && meta.y < body.y, 'head, meta, body stack in that order')
    assert.ok(Math.abs(meta.x - head.x) < 2, 'one column')
    const remove = await box(dialog.getByRole('button', { name: 'Remove Performance' }))
    assert.ok(remove.width >= 44, `a pill × is a 44 px target under a finger (${remove.width}px)`)
    await settled(page)
    await page.screenshot({ path: shot('08-phone-details.png') })

    const input = dialog.getByRole('combobox', { name: 'Labels' })
    await input.scrollIntoViewIfNeeded()
    await input.focus()
    const list = page.getByRole('listbox', { name: 'Labels' })
    await list.waitFor()
    const field = await box(dialog.locator('.admin-token-input').first())
    const popover = await box(page.locator('.admin-token-input-popover'))
    assert.ok(popover.y >= field.y + field.height - 1, 'the list opens below the field')
    assert.ok(popover.height <= 812 * 0.4 + 60, 'and stays within 40vh plus its footer')
    await settled(page)
    await page.screenshot({ path: shot('09-phone-labels-open.png') })
    await page.close()
  }
  // 18 — the work chip on a phone: first in the meta group, under the title.
  {
    const page = await open(phone, 'scenario=details&work=active')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    const chip = dialog.getByTestId('ticket-work-chip')
    await chip.waitFor()
    await chip.scrollIntoViewIfNeeded()
    const chipBox = await box(chip)
    assert.ok(chipBox.width <= 375 && chipBox.x >= 0, 'the chip fits the phone')
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scroll <= 375, `nothing scrolls sideways (${scroll})`)
    await settled(page)
    await page.screenshot({ path: shot('18-phone-work.png') })
    await page.close()
  }
  // 15 — On a phone the header Back is the doorway most people press.
  {
    const page = await open(phone, 'scenario=viewer-back')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    const row = dialog.getByTestId('task-attachments').locator(`li[data-attachment-id="${IMAGE_ID}"] button`).first()
    await row.scrollIntoViewIfNeeded()
    await assertViewerOwnsBack(page, row, { label: 'phone header Back', screenshot: '15-phone-viewer-over-ticket.png' })
    await page.close()
  }
  await phone.close()

  // 19 — the reminder the agent set and the question it waits on (T3,
  // docs/standards/ticket-work.md): "Checking back at 14:35 — waiting for
  // CI" with Cancel for a board editor, the Cancel sent as the route's DELETE
  // and the line gone after it, the same line and no Cancel for a reader who
  // cannot edit the board, and the open question — at 1280 and 390 px.
  for (const width of [1280, 390]) {
    const phoneWidth = width < 768
    const context = await browser.newContext({
      viewport: { height: phoneWidth ? 844 : 900, width },
      ...(phoneWidth ? { hasTouch: true, isMobile: true } : {}),
    })
    await routeBytes(context)
    const chipOf = async (query) => {
      const page = await open(context, query)
      const chip = page.getByRole('dialog', { name: 'Task details' }).getByTestId('ticket-work-chip')
      await chip.waitFor()
      await chip.scrollIntoViewIfNeeded()
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(scroll <= width, `${query}: nothing scrolls sideways at ${width}px (${scroll})`)
      return { chip, page }
    }
    {
      const { chip, page } = await chipOf('scenario=details&work=reminder')
      const reminder = chip.getByTestId('ticket-work-reminder')
      assert.match(await reminder.innerText(), /^Checking back at \S.* — waiting for CI\s*Cancel$/)
      assert.match(await chip.innerText(), /Last woken .+: nothing else was scheduled · wake 3 of 30/)
      const cancel = reminder.getByRole('button', { name: 'Cancel' })
      const target = await box(cancel)
      assert.ok(target.x + target.width <= width, 'Cancel is on screen')
      await settled(page)
      await chip.screenshot({ path: shot(`19-work-reminder-${width}.png`) })
      if (!phoneWidth) await page.screenshot({ path: shot('19-work-reminder-dialog-1280.png') })
      await cancel.click()
      await reminder.waitFor({ state: 'detached' })
      const deletes = (await calls(page)).filter((call) => call.method === 'DELETE').map((call) => call.path)
      assert.deepEqual(deletes, [
        '/api/tasks/10000000-0000-4000-8000-000000000006/work/reminders/70000000-0000-4000-8000-000000000014',
      ])
      await settled(page)
      await chip.screenshot({ path: shot(`19-work-reminder-cancelled-${width}.png`) })
      await page.close()
    }
    {
      const { chip, page } = await chipOf('scenario=details&work=reminder-reader')
      const reminder = chip.getByTestId('ticket-work-reminder')
      assert.match(await reminder.innerText(), /^Checking back at \S.* — waiting for CI$/)
      assert.equal(await reminder.getByRole('button').count(), 0, 'no Cancel for a reader who cannot edit the board')
      await settled(page)
      await chip.screenshot({ path: shot(`19-work-reminder-reader-${width}.png`) })
      await page.close()
    }
    {
      const { chip, page } = await chipOf('scenario=details&work=question')
      assert.match(
        await chip.getByTestId('ticket-work-question').innerText(),
        /^Waiting for an answer on the ticket since \S/,
      )
      assert.equal(await chip.getByTestId('ticket-work-reminder').count(), 0)
      await settled(page)
      await chip.screenshot({ path: shot(`19-work-question-${width}.png`) })
      await page.close()
    }
    await context.close()
  }

  // 20–28 — T4's machine states (docs/plans/2026-09-23-ticket-driven-agents/
  // ticket-work.md → "What the project sees"): the chip's state line for work
  // queued at position 2, paused with its machine offline, waiting for machine
  // access not set up or paused, stopped at its hours or its budget, and ended
  // with its machine access, each with the newest history row that says it;
  // the line a wake that ran without a machine leaves on live work; and a
  // history of a queue, an offline pause and two resumes — at 1280 and 390 px.
  // The record the chip reads carries no machine, so none is named on it.
  const MACHINE_CHIP_STATES = [
    ['queued', '20-work-queued', 'queued', /^Perf agent · queued · started /,
      'Queued: position 2 — every machine is busy.',
      / · Perf agent queued the work: every machine is busy · by Ondřej Rafaj$/],
    ['machine-offline', '21-work-machine-offline', 'waiting_machine', /^Perf agent · waiting for a machine · /,
      'Paused: the machine is offline. Work resumes when it reconnects.',
      / · Perf agent paused the work: the machine is offline$/],
    ['access-not-set-up', '22-work-access-not-set-up', 'waiting_machine', /^Perf agent · waiting for a machine · /,
      'Waiting for machine access: its owner has not set it up yet.',
      / · Perf agent started work, waiting for machine access · by Ondřej Rafaj$/],
    ['access-suspended', '23-work-access-suspended', 'waiting_machine', /^Perf agent · waiting for a machine · /,
      'Waiting for machine access: it is paused until its owner confirms it again.',
      / · Perf agent paused the work: machine access is paused$/],
    ['stopped-hours', '24-work-stopped-hours', 'failed', /^Perf agent · stopped · /,
      'Stopped: its hours are used up. Move the ticket out of and back into a start-work column to continue.',
      / · Perf agent ended the work: its hours are used up$/],
    ['stopped-cost', '25-work-stopped-cost', 'failed', /^Perf agent · stopped · /,
      'Stopped: its budget is used up. Move the ticket out of and back into a start-work column to continue.',
      / · Perf agent ended the work: its budget is used up$/],
    ['access-ended', '26-work-access-ended', 'cancelled', /^Perf agent · ended · /,
      'Ended: its machine access ended.',
      / · Perf agent ended the work: machine access ended$/],
  ]
  const NAMES_A_MACHINE = /executor|Studio|Mac mini|\bPC\b/i
  for (const width of [1280, 390]) {
    const phoneWidth = width < 768
    const context = await browser.newContext({
      viewport: { height: phoneWidth ? 844 : 900, width },
      ...(phoneWidth ? { hasTouch: true, isMobile: true } : {}),
    })
    await routeBytes(context)
    const chipOf = async (state) => {
      const page = await open(context, `scenario=details&work=${state}`)
      const dialog = page.getByRole('dialog', { name: 'Task details' })
      const chip = dialog.getByTestId('ticket-work-chip')
      await chip.waitFor()
      await chip.scrollIntoViewIfNeeded()
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(scroll <= width, `${state}: nothing scrolls sideways at ${width}px (${scroll})`)
      return { chip, dialog, page }
    }
    for (const [state, name, status, headline, line, newestRow] of MACHINE_CHIP_STATES) {
      const { chip, dialog, page } = await chipOf(state)
      assert.equal(await chip.getAttribute('data-work-status'), status, state)
      assert.match(await chip.getByTestId('ticket-work-headline').innerText(), headline, state)
      assert.equal((await chip.getByTestId('ticket-work-state').innerText()).trim(), line, state)
      assert.equal(await chip.getByTestId('ticket-work-machine-refusal').count(), 0, `${state}: no refused wake to say`)
      assert.doesNotMatch(await chip.innerText(), NAMES_A_MACHINE, `${state}: the chip names no machine`)
      // The history's newest row says the same, folded away: textContent, not
      // innerText, which skips what a closed fold hides.
      const newest = await dialog.getByTestId('ticket-work-history').locator('li').first().textContent()
      assert.match(newest ?? '', newestRow, `${state}: ${newest}`)
      await settled(page)
      await chip.screenshot({ path: shot(`${name}-${width}.png`) })
      await page.close()
    }
    // 27 — live work whose latest wake ran without a machine says why, once,
    // in the sentence the run itself was told.
    {
      const { chip, page } = await chipOf('machine-refusal')
      assert.equal(await chip.getAttribute('data-work-status'), 'active')
      assert.match(await chip.getByTestId('ticket-work-headline').innerText(), /^Perf agent · working · started /)
      assert.equal(
        (await chip.getByTestId('ticket-work-machine-refusal').innerText()).trim(),
        'Ran without a machine: the machine was offline or no longer offers its coding tools.',
      )
      assert.equal(await chip.getByTestId('ticket-work-state').count(), 0, 'working work has no state line')
      assert.doesNotMatch(await chip.innerText(), NAMES_A_MACHINE, 'the refusal names no machine')
      await settled(page)
      await chip.screenshot({ path: shot(`27-work-machine-refusal-${width}.png`) })
      await page.close()
    }
    // 28 — the work history of a start no machine took, its queue, its turn
    // coming, and its machine going offline and coming back.
    {
      const { chip, dialog, page } = await chipOf('machine-history')
      assert.match(await chip.innerText(), /Last woken .+: the machine came back · wake 6 of 30/)
      const history = dialog.getByTestId('ticket-work-history')
      assert.match(await history.locator('summary').innerText(), /^Work history \(5\)$/)
      await history.locator('summary').click()
      const rows = await history.locator('li').allInnerTexts()
      assert.equal(rows.length, 5, rows.join('\n'))
      assert.match(rows[0], / · Perf agent resumed the work$/)
      assert.match(rows[1], / · Perf agent paused the work: the machine is offline$/)
      assert.match(rows[2], / · Perf agent resumed the work$/)
      assert.match(rows[3], / · Perf agent queued the work: every machine is busy · by Ondřej Rafaj$/)
      assert.match(rows[4], / · Perf agent started work, queued for a machine · by Ondřej Rafaj$/)
      assert.doesNotMatch(rows.join('\n'), NAMES_A_MACHINE, 'the history names no machine')
      const section = dialog.locator('section[aria-label="Agent work on this ticket"]')
      await section.scrollIntoViewIfNeeded()
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(scroll <= width, `the open history does not scroll sideways at ${width}px (${scroll})`)
      await settled(page)
      await section.screenshot({ path: shot(`28-work-machine-history-${width}.png`) })
      await page.close()
    }
    await context.close()
  }

  console.log(`Task dialog proofs passed: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
