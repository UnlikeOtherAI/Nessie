import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { submitMentionedRequest, waitForRun } from './fixture.mjs'

export const exerciseApprovedReplyRevision = async ({
  activateRevision,
  api,
  audiencePage,
  audienceToken,
  currentContent,
  fixture,
  forwarded,
  revisedContent,
  runIds,
  screenshots,
  sourcePage,
  sourceToken,
  pipeline,
}) => {
  const sseStart = await audiencePage.evaluate(() => window.__disclosureEventProbe?.events.length ?? 0)
  const wsStart = await audiencePage.evaluate(() => window.__disclosureActivityProbe?.events.length ?? 0)
  activateRevision()
  await sourcePage.goto(`http://localhost:5455/channels/${fixture.privateChannel.id}`, { waitUntil: 'domcontentloaded' })
  await submitMentionedRequest(
    sourcePage,
    fixture.scope.agentId,
    'Disclosure',
    'Prosím uprav už zveřejněný update na aktuální citlivé znění.',
  )
  const revisionRun = await waitForRun(pipeline, fixture.scope.agentId, fixture.privateThread.id, runIds)
  runIds.push(revisionRun.id)
  const terminal = await pipeline.waitForTerminalRuns([revisionRun.id], 60_000)
  assert.equal(terminal.get(revisionRun.id), 'completed', 'B’s private message edit completes')
  const edit = await pipeline.prisma.toolCall.findFirstOrThrow({
    where: { runId: revisionRun.id, toolName: 'message_edit' },
    select: { success: true },
  })
  assert.equal(edit.success, true, 'the worker executed the message_edit tool')
  const revised = await pipeline.prisma.message.findUniqueOrThrow({
    where: { id: forwarded.id }, select: { content: true },
  })
  assert.equal(revised.content, revisedContent, 'the approved reply was replaced with current private content')
  const revoked = await pipeline.prisma.disclosureGrant.findFirstOrThrow({
    where: { messageId: forwarded.id }, orderBy: { grantedAt: 'desc' }, select: { revokedAt: true },
  })
  assert.notEqual(revoked.revokedAt, null, 'editing content revokes the prior active grant')

  const assertNoRevision = (value, boundary) => assert.equal(
    String(value).includes(revisedContent),
    false,
    `${boundary} exposed the edited private content`,
  )
  assertNoRevision(await audiencePage.locator('body').innerText(), 'C open transcript after edit')
  const sseFrames = await audiencePage.evaluate(
    (start) => window.__disclosureEventProbe?.events.slice(start) ?? [], sseStart,
  )
  const wsFrames = await audiencePage.evaluate(
    (start) => window.__disclosureActivityProbe?.events.slice(start) ?? [], wsStart,
  )
  assertNoRevision(JSON.stringify(sseFrames), 'C SSE frames after edit')
  assertNoRevision(JSON.stringify(wsFrames), 'C activity WebSocket frames after edit')
  const refreshed = await api(`/api/threads/${fixture.groupThread.id}/messages`, audienceToken)
  const restricted = refreshed.data.find((message) => message.id === forwarded.id)
  assert.equal(restricted?.restrictedSources, true, 'C refetch receives the edited reply as restricted')
  assertNoRevision(JSON.stringify(restricted), 'C thread API response after edit')
  await audiencePage.screenshot({ path: resolve(screenshots, 'before-edited-source-author-share.png'), fullPage: true })

  const stale = await fetch(`http://127.0.0.1:5454/api/messages/${forwarded.id}/disclosure-grants`, {
    body: JSON.stringify({ expectedContent: currentContent, kind: 'message', duration: '10m' }),
    headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
    method: 'POST',
  })
  assert.equal(stale.status, 409, 'an approval for the old content is rejected')

  await sourcePage.goto(`http://localhost:5455/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' })
  const sourceCard = sourcePage.locator(`#msg-${forwarded.id}`)
  await sourceCard.getByRole('button', { name: 'Share this reply' }).waitFor({ timeout: 60_000 })
  const shareRequest = sourcePage.waitForRequest((request) =>
    request.method() === 'POST' && request.url().endsWith(`/api/messages/${forwarded.id}/disclosure-grants`),
  )
  const shareResponse = sourcePage.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith(`/api/messages/${forwarded.id}/disclosure-grants`),
  )
  await sourceCard.getByRole('button', { name: 'Share this reply' }).click()
  assert.equal(JSON.parse((await shareRequest).postData() ?? '{}').expectedContent, revisedContent,
    'B’s refreshed control approves the content it displayed')
  assert.equal((await shareResponse).status(), 201, 'B can approve the current edited content')
  await audiencePage.waitForFunction((content) => document.body.innerText.includes(content), revisedContent, {
    timeout: 60_000,
  })
  await audiencePage.screenshot({ path: resolve(screenshots, 'after-edited-source-author-share.png'), fullPage: true })
}
