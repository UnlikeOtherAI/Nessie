import assert from 'node:assert/strict'

/**
 * One-on-one rooms (docs/standards/reply-threads.md → "One-on-one rooms").
 *
 * Two claims. First, where answers land: every answer this run's scripted
 * model gave inside the agent's own DM — its conversations included — sits in
 * the main chat, not in a reply thread under the question. This stack has no
 * Ledger, so Jev never judges a turn here and what is proved is the room's
 * structural answer, the one every judgement falls back to.
 *
 * Second, the reader's side of a reply Jev linked back to an earlier message.
 * Jev is not reachable from this stack, so that reply is planted with exactly
 * the metadata the run's completion writes (`messageRef`), as the card case
 * plants its doorway: the link shows the earlier message the way the reader's
 * own feed has it, and pressing it takes them there.
 */
export const exerciseMessageRef = async ({ fixture, gallery, goto, pipeline }) => {
  const answers = await pipeline.prisma.message.findMany({
    select: { content: true, rootMessageId: true },
    where: { content: { startsWith: 'Echo:' }, role: 'assistant', thread: { channelId: fixture.dmRoom.id } },
  })
  assert.ok(answers.length >= 2, `the agent answered in its DM: ${answers.length}`)
  for (const answer of answers) {
    assert.equal(answer.rootMessageId, null,
      `a one-on-one answer is in the main chat, not under its question: ${answer.content}`)
  }

  const threadId = fixture.dmThread.id
  const earlier = await pipeline.prisma.message.create({
    data: {
      content: 'Launch je 12. října — zapamatuj si to, prosím.',
      role: 'user',
      threadId,
      userId: fixture.owner.id,
    },
    select: { id: true },
  })
  // Enough turns between the two that the earlier message is out of view on a
  // phone, so the jump is a real scroll rather than a flash in place.
  for (let turn = 1; turn <= 6; turn += 1) {
    await pipeline.prisma.message.create({
      data: turn % 2
        ? { content: `ok lets plan teh blog post, part ${turn}`, role: 'user', threadId, userId: fixture.owner.id }
        : { agentId: fixture.agent.id, content: `Outline, part ${turn}.`, role: 'assistant', threadId },
    })
  }
  await pipeline.prisma.message.create({
    data: {
      agentId: fixture.agent.id,
      content: 'Dvanáctého října, jak jsi psal výš.',
      metadata: { messageRef: { messageId: earlier.id } },
      role: 'assistant',
      threadId,
    },
  })

  await gallery.capture('message-ref', async (page, viewport) => {
    await goto(page, `/channels/${fixture.dmRoom.id}/threads/${threadId}`)
    const chip = page.locator('[data-testid="message-ref-chip"]').last()
    await chip.waitFor({ timeout: 60_000 })
    const label = await chip.innerText()
    assert.ok(label.includes('You'), `the link names who wrote the earlier message (${viewport}): ${label}`)
    assert.ok(label.includes('Launch je 12. října'),
      `the link quotes it from the reader's own feed (${viewport}): ${label}`)
    await chip.click()
    await page.waitForFunction(
      (id) => document.getElementById(`msg-${id}`)?.classList.contains('admin-msg-highlight') ?? false,
      earlier.id,
      { timeout: 5_000 },
    )
  })
}
