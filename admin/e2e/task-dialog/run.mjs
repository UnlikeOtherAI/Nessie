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
 * Labels settings section, no database. What it pins is geometry and
 * behaviour a unit test cannot see — Documents sitting directly under the
 * description in the left column rather than under the whole grid, the Labels
 * field staying a compact growing field instead of a wall of every label, the
 * token field's keys, the three read-only states and the phone's stacked
 * order — and every state is screenshotted under e2e/screenshots/task-dialog/.
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

/** Bytes leave through fetch/XHR, not the ApiClient: answer them here. */
const routeBytes = async (context) => {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
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
  assert.equal(await attachments.locator('li[data-attachment-id]').count(), 3)
  await attachments.getByText('in description').waitFor()
  await attachments.getByText('Checkout redesign — Figma').waitFor()
  await attachments.getByText("Couldn't copy from Linear").waitFor()
  assert.equal(await attachments.getByRole('link', { name: 'Open in Linear ↗' }).count(), 1)

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
    await dialog.getByTestId('task-attachments').locator('li[data-attachment-id]').nth(3).waitFor()
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
    assert.equal(await options.count(), 7, 'every label of the project is listed')
    for (let index = 0; index < 4; index += 1) {
      assert.equal(await options.nth(index).getAttribute('aria-selected'), 'true', 'chosen labels come first')
    }
    const manage = page.getByRole('link', { name: 'Manage labels…' })
    assert.equal(await manage.getAttribute('href'), '/projects/10000000-0000-4000-8000-000000000002/settings?section=labels')
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

  // 10 — Settings → Labels: rename in progress, the colour popover open.
  {
    const page = await open(desktop, 'scenario=settings')
    await page.getByText('12 tickets').waitFor()
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
    await page.getByRole('button', { name: 'Rename Design' }).click()
    await page.getByRole('textbox', { name: 'Name of Design' }).fill('Design syst')
    await page.getByRole('button', { name: /Colour of Backend/ }).click()
    await page.getByRole('dialog', { name: /Colour of Backend/ }).waitFor()
    await settled(page)
    await page.screenshot({ path: shot('10-labels-settings.png') })
    await page.close()
  }

  // 11 — a card: three label pills, +1, the comment and paperclip counts.
  {
    const page = await open(desktop, 'scenario=card')
    const card = page.locator('[data-kanban-card]')
    await card.waitFor()
    assert.equal(await card.locator('.admin-label-pill').count(), 3)
    await card.getByText('+1', { exact: true }).waitFor()
    await card.locator('[title="4 comments"]').waitFor()
    await card.locator('[title="3 files"]').waitFor()
    await settled(page)
    await card.screenshot({ path: shot('11-card.png') })
    await page.close()
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
  await phone.close()

  console.log(`Task dialog proofs passed: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
