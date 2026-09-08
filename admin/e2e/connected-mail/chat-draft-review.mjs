// Chat-mail review scenarios share the production connected-mail fixture and
// browser setup from run.mjs. Keeping them together makes the card-to-editor
// contract visible without turning the main runner into another test framework.

const chatDoorway = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    await page.getByRole('heading', { name: 'Email triage' }).waitFor()
    assert(await page.getByTestId('mail-surface-doorway').count() === 0, 'doorway should not exist before the message refetch')
    fixture.showDoorway()
    // The response changes after the conversation has already mounted; a
    // product reload is the stable browser-level refetch seam (and avoids
    // reaching into React Query internals from the test).
    await page.reload()
    await page.getByTestId('mail-surface-doorway').waitFor()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByTestId('connected-mail-conversation').waitFor()
    await shot(page, 'chat-doorway-auto-popup')

    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.reload()
    await page.getByTestId('mail-surface-doorway').waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'the same message reopened a session-scoped automatic popup')

    fixture.denyDoorway()
    const opener = page.getByRole('button', { name: 'Open mail' })
    await opener.click()
    await page.getByText('This email is no longer available to you.').waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'doorway opened after live entitlement was removed')
    fixture.allowDoorway()
    await opener.click()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert(await opener.evaluate((element) => document.activeElement === element), 'dialog close did not restore focus to the mail doorway')

    await opener.click()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByRole('button', { name: 'Open full mail' }).click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1\/threads\/thread-1$/)
    await page.getByTestId('connected-mail-conversation').waitFor()

    // A second chat render carries a Gmail draft pointer. The form is the
    // same production composer used by Mail; it is not an email-shaped card.
    fixture.showComposeDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const gmailPreview = page.getByTestId('gmail-chat-draft-preview')
    await gmailPreview.waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'a Gmail draft preview opened before the person chose Edit')
    assert(await gmailPreview.getByRole('button', { name: 'Send' }).isVisible(), 'Gmail preview did not offer direct Send')
    assert(await gmailPreview.getByRole('button', { name: 'Edit' }).isVisible(), 'Gmail preview did not offer Edit')
    const composeOpener = page.getByRole('button', { name: 'Edit' })
    await composeOpener.waitFor()
    await composeOpener.click()
    await page.getByRole('dialog', { name: 'Compose email' }).waitFor()
    assert(await page.getByRole('textbox', { name: 'From', exact: true }).isDisabled(), 'chat draft form exposed a mutable From field')
    await page.getByRole('textbox', { name: 'Subject', exact: true }).waitFor()
    // The doorway remains the one composer while its shell expands and
    // restores. Values must survive both layout changes; recreating a composer
    // here would silently discard a person’s edit.
    const doorwayContent = page.getByTestId('connected-mail-compose-dialog')
    assert(await doorwayContent.getAttribute('data-fullscreen') === 'false', 'draft doorway started maximized')
    await page.getByRole('textbox', { name: 'Cc', exact: true }).fill('team@acme.example')
    await page.getByRole('textbox', { name: 'Bcc', exact: true }).fill('audit@acme.example')
    await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Launch plan review')
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('The doorway draft is ready to send.')
    const restoredWidth = (await page.getByRole('dialog', { name: 'Compose email' }).boundingBox())?.width ?? 0
    await page.getByTestId('mail-compose-dialog-maximize').click()
    await page.getByTestId('mail-compose-dialog-restore').waitFor()
    assert(await doorwayContent.getAttribute('data-fullscreen') === 'true', 'maximize did not mark the expanded doorway')
    const maximizedWidth = (await page.getByRole('dialog', { name: 'Compose email' }).boundingBox())?.width ?? 0
    assert(maximizedWidth > restoredWidth, `maximize did not expand the email doorway (${restoredWidth}px -> ${maximizedWidth}px)`)
    assert(await page.getByRole('textbox', { name: 'Cc', exact: true }).inputValue() === 'team@acme.example', 'maximize discarded Cc')
    assert(await page.getByRole('textbox', { name: 'Bcc', exact: true }).inputValue() === 'audit@acme.example', 'maximize discarded Bcc')
    assert(await page.getByRole('textbox', { name: 'Subject', exact: true }).inputValue() === 'Launch plan review', 'maximize discarded the subject')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'The doorway draft is ready to send.', 'maximize discarded the body')
    await page.getByTestId('mail-compose-dialog-restore').click()
    await page.getByTestId('mail-compose-dialog-maximize').waitFor()
    assert(await doorwayContent.getAttribute('data-fullscreen') === 'false', 'restore did not return the doorway to its normal state')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'The doorway draft is ready to send.', 'restore discarded the body')
    await shot(page, 'chat-doorway-compose-form')
    await page.getByTestId('mail-compose-dialog-maximize').click()
    await page.getByTestId('mail-compose-dialog-restore').waitFor()
    await shot(page, 'chat-doorway-compose-maximized')
    await page.getByTestId('mail-compose-dialog-restore').click()
    await page.getByTestId('mail-compose-dialog-maximize').waitFor()
    // This doorway fetched the existing draft's `draft` status before Send.
    // The held result must atomically replace it rather than letting that
    // stale read erase the newly persisted Undo identity.
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.getByText('Your email is queued to send.').waitFor()
    await page.getByRole('button', { name: 'Close' }).click()

    // This route carries the provider action id, not a local-draft key. Its
    // reload still has to recover the held Undo doorway without sending again.
    await page.reload()
    await composeOpener.click()
    await page.getByRole('button', { name: 'Undo send' }).waitFor()
    fixture.setGmailDraftActionStatus({ sendAfter: null, state: 'dispatching' })
    await page.getByRole('button', { name: 'Close' }).click()
    await page.reload()
    await composeOpener.click()
    await page.getByText('Your email is being delivered. It will not be sent again.').waitFor()
    assert(await page.getByRole('button', { name: 'Undo send' }).count() === 0, 'a reloaded doorway dispatch offered Undo')
    await page.getByRole('button', { name: 'Close' }).click()

    // A selected review list stays in chat as live rows. It contains only the
    // structural ids the agent picked, and opens the canonical reader only
    // after the person selects one.
    fixture.showSelectedAccountDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const selectedReview = page.getByTestId('mail-surface-selected-threads')
    await selectedReview.waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'selected review opened a dialog before a person chose an email')
    const selectedList = selectedReview.getByRole('listbox', { name: 'Selected mail conversations' })
    await selectedList.waitFor()
    await selectedList.getByText('Launch checklist', { exact: true }).waitFor()
    await selectedList.getByText('Budget', { exact: true }).waitFor()
    assert(await selectedList.getByRole('option').count() === 2, 'selected review rendered emails outside the requested ids')
    assert(await selectedReview.getByText('Choose a conversation to open it in Mail.').count() === 0, 'selected review retained an empty reader pane in chat')
    await shot(page, 'chat-doorway-selected-emails')
    await selectedReview.locator('#mailbox-thread-thread-2').click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1\/threads\/thread-2$/)
    await page.getByTestId('connected-mail-conversation').waitFor()
    fixture.denyDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    assert(await page.getByTestId('mail-surface-selected-threads').count() === 0, 'revoked access left selected email details visible')
    fixture.allowDoorway()

    // Account doorways carry the real, entitlement-scoped mailbox list into
    // chat. Selecting its row must enter the normal reader route, not an
    // email-shaped summary card with a second navigation implementation.
    fixture.showAccountDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const accountOpener = page.getByRole('button', { name: 'Open mail' })
    await accountOpener.click()
    const accountDialog = page.getByRole('dialog', { name: 'Mail ready to review' })
    await accountDialog.waitFor()
    const accountPreview = accountDialog.getByTestId('mailbox-workspace')
    await accountPreview.waitFor()
    assert(await accountPreview.getAttribute('data-layout') === 'single', 'account doorway did not embed the canonical mailbox list')
    await accountDialog.getByRole('listbox', { name: 'Mail conversations' }).waitFor()
    await shot(page, 'chat-doorway-account-preview')
    await accountDialog.locator('#mailbox-thread-thread-1').click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1\/threads\/thread-1$/)
    await page.getByTestId('connected-mail-conversation').waitFor()
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const gmailPreviewDirectSend = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    fixture.showDoorway()
    fixture.showComposeDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const preview = page.getByTestId('gmail-chat-draft-preview')
    const sendButton = preview.getByRole('button', { name: 'Send' })
    await sendButton.waitFor()
    assert(await sendButton.isEnabled(), 'an editable Gmail draft preview did not enable Send')
    const sent = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/gmail/drafts/${fixture.ids.gmailDraft}/send`)
    await sendButton.click()
    await sent
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Send' && button.disabled))
    const sends = fixture.calls.filter((call) => call.method === 'POST' && call.pathname === `/api/gmail/drafts/${fixture.ids.gmailDraft}/send`)
    assert(sends.length === 1, `Gmail preview dispatched ${sends.length} sends`)
    assert(JSON.parse(sends[0].postData ?? '{}').expectedFingerprint === 'fingerprint-1', 'Gmail preview did not bind Send to the displayed draft fingerprint')
    assert(await sendButton.isDisabled(), 'Gmail preview remained editable after Send')
    await shot(page, 'gmail-chat-draft-direct-send')
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const gmailPreviewRevocation = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    fixture.showComposeDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    await page.getByTestId('gmail-chat-draft-preview').waitFor()
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByTestId('connected-mail-compose-dialog').waitFor()

    // A query focus refresh models the live entitlement update that arrives
    // while a person is editing. The mounted composer must disappear with the
    // account, rather than retaining provider content under stale access.
    const accountsRefresh = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/mail/accounts')
    fixture.denyDoorway()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await accountsRefresh
    await page.getByTestId('connected-mail-compose-dialog').waitFor({ state: 'detached' })
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).count() === 0, 'revoked Gmail access left the editor content mounted')
    await shot(page, 'gmail-preview-revoked-editor')
  } finally {
    fixture.allowDoorway()
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const agentCardMailDraft = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    fixture.showMailboxComposeCard()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const card = page.getByTestId('agent-card')
    await card.waitFor()
    assert(await card.getByRole('textbox', { name: /^To/ }).inputValue() === 'casey@acme.example', 'mail card did not show the selected recipient')
    assert(await card.getByRole('textbox', { name: 'Cc', exact: true }).inputValue() === 'team@acme.example', 'mail card did not show Cc')
    assert(await card.getByRole('textbox', { name: 'Bcc', exact: true }).inputValue() === 'audit@acme.example', 'mail card did not show Bcc')
    assert(await card.getByRole('textbox', { name: /^Subject/ }).inputValue() === 'Launch plan', 'mail card did not show the selected subject')
    assert(await card.getByRole('textbox', { name: /^Message/ }).inputValue() === 'Please review the attached launch plan.', 'mail card did not show the selected body')
    const compactCard = await card.evaluate((node) => {
      const control = node.querySelector('input')
      return {
        controlHeight: control?.getBoundingClientRect().height ?? 0,
        fontSize: getComputedStyle(node).fontSize,
        surface: getComputedStyle(node).backgroundColor,
      }
    })
    assert(compactCard.fontSize === '12px', `mail card did not use compact type (${compactCard.fontSize})`)
    assert(compactCard.controlHeight <= 32, `mail card controls are no longer dense (${compactCard.controlHeight}px)`)
    assert(compactCard.surface !== 'rgba(0, 0, 0, 0)', 'mail card has no distinct theme surface')
    await shot(page, 'agent-card-mail-draft-open')

    // Edit is a same-app route with an opaque card id. No mail content enters
    // the URL; the destination repeats the viewer-scoped card lookup before
    // it hydrates the production composer.
    await card.getByRole('textbox', { name: /^To/ }).fill('')
    await card.getByTestId('agent-card-action-edit').click()
    await page.waitForURL(new RegExp(`/mail/mailbox/mailbox-1/compose\\?agentCard=${fixture.ids.mailboxComposeCard}`))
    await page.getByRole('heading', { name: 'Compose email' }).waitFor()
    assert(await page.getByRole('textbox', { name: 'To', exact: true }).inputValue() === '', 'Edit did not preserve an intentionally blank required field')
    assert(await page.getByRole('textbox', { name: 'Cc', exact: true }).inputValue() === 'team@acme.example', 'Edit did not preserve Cc')
    assert(await page.getByRole('textbox', { name: 'Bcc', exact: true }).inputValue() === 'audit@acme.example', 'Edit did not preserve Bcc')
    assert(await page.getByRole('textbox', { name: 'Subject', exact: true }).inputValue() === 'Launch plan', 'Edit did not preserve Subject')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Please review the attached launch plan.', 'Edit did not preserve Message')
    const composeSurface = page.getByTestId('connected-mail-compose-dialog')
    assert(await composeSurface.getAttribute('data-fullscreen') === 'false', 'SMTP edit unexpectedly started maximized')
    await page.getByTestId('mail-compose-dialog-maximize').click()
    await page.getByTestId('mail-compose-dialog-restore').waitFor()
    assert(await composeSurface.getAttribute('data-fullscreen') === 'true', 'SMTP edit did not enter full viewport mode')
    const fullscreenBounds = await page.getByRole('dialog', { name: 'Compose email' }).boundingBox()
    assert((fullscreenBounds?.width ?? 0) >= 1_200, `SMTP edit did not occupy the desktop viewport (${fullscreenBounds?.width ?? 0}px)`)
    assert(await page.getByRole('textbox', { name: 'To', exact: true }).inputValue() === '', 'SMTP maximize discarded an intentionally blank To')
    assert(await page.getByRole('textbox', { name: 'Cc', exact: true }).inputValue() === 'team@acme.example', 'SMTP maximize discarded Cc')
    assert(await page.getByRole('textbox', { name: 'Bcc', exact: true }).inputValue() === 'audit@acme.example', 'SMTP maximize discarded Bcc')
    assert(await page.getByRole('textbox', { name: 'Subject', exact: true }).inputValue() === 'Launch plan', 'SMTP maximize discarded Subject')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Please review the attached launch plan.', 'SMTP maximize discarded Message')
    await page.getByTestId('mail-compose-dialog-restore').click()
    await page.getByTestId('mail-compose-dialog-maximize').waitFor()
    assert(await composeSurface.getAttribute('data-fullscreen') === 'false', 'SMTP restore did not leave full viewport mode')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Please review the attached launch plan.', 'SMTP restore discarded Message')
    await page.reload()
    await page.getByRole('heading', { name: 'Compose email' }).waitFor()
    assert(await page.getByRole('textbox', { name: 'To', exact: true }).inputValue() === '', 'an Edit reload lost the intentionally blank recipient')
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue() === 'Please review the attached launch plan.', 'an Edit reload lost the viewer-scoped draft')
    await shot(page, 'agent-card-mail-draft-edit')

    // A card carries one selected mailbox. Even an otherwise-authorized
    // viewer may not substitute another mailbox id into its edit URL.
    await page.goto(`${adminUrl}/mail/mailbox/mailbox-2/compose?agentCard=${fixture.ids.mailboxComposeCard}`)
    await page.getByText('This email draft is no longer available to you.').waitFor()
    assert(await page.getByRole('textbox', { name: 'Message', exact: true }).count() === 0, 'a card draft hydrated under a different mailbox account')

    // Returning to the originating chat must show the API-claimed result. A
    // fresh fixture below exercises Send separately; this card can no longer
    // present a second action after its Edit claim.
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const settledCard = page.getByTestId('agent-card')
    await settledCard.waitFor()
    await settledCard.getByText('Edit by Alex Example').waitFor()
    assert(await settledCard.getByTestId('agent-card-action-send').count() === 0, 'a claimed Edit card still offered Send')

  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}


const narrowComposeDoorway = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 1024, name: 'tablet', width: 768 })
  const { page } = target
  try {
    fixture.showComposeDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    await page.getByTestId('gmail-chat-draft-preview').getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByTestId('connected-mail-compose-dialog')
    await dialog.waitFor()
    const maximize = page.getByTestId('mail-compose-dialog-maximize')
    if (await maximize.count()) {
      await maximize.click()
      await page.getByTestId('mail-compose-dialog-restore').waitFor()
      assert(await dialog.getAttribute('data-fullscreen') === 'true', 'narrow compose did not enter full viewport mode')
    }
    await shot(page, 'chat-doorway-compose-maximized-narrow')
    const shell = page.getByRole('dialog', { name: 'Compose email' })
    const bounds = await shell.boundingBox()
    assert((bounds?.width ?? 0) >= 736, `narrow dialog did not occupy the viewport minus its 2rem gutter (${bounds?.width ?? 0}px)`)
    await page.getByRole('button', { name: 'Send email' }).scrollIntoViewIfNeeded()
    assert(await page.getByRole('button', { name: 'Send email' }).isVisible(), 'narrow composer did not keep Send reachable')
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const agentCardMailSend = async ({ adminUrl, assert, browser, expectNoErrors, fixture, newPage, shot }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    fixture.showMailboxComposeCard()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const card = page.getByTestId('agent-card')
    await card.waitFor()
    await card.getByTestId('agent-card-action-send').click()
    await page.getByText('Send by Alex Example').waitFor()
    assert(fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/respond') && call.postData?.includes('"actionKey":"send"')), 'Send did not record the fresh card response')
    assert(!fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/send')), 'card Send bypassed the mail approval and send flow')
    await shot(page, 'agent-card-mail-draft-send')
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

export {
  agentCardMailDraft,
  agentCardMailSend,
  chatDoorway,
  gmailPreviewDirectSend,
  gmailPreviewRevocation,
  narrowComposeDoorway,
}
