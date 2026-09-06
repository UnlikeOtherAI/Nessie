import type { PrismaClient } from '@prisma/client'
import { claimThreadRunOrPend, enqueueRunExecution } from '@nessie/db'
import { createSystemAuthoredMessage } from '@nessie/team-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * Telling the agent that a person has finished with its browser.
 *
 * The sign-in hand-over is a loop: the agent asks, the person takes the
 * controls and is unobserved while they hold them, and then it carries on. The
 * "carries on" needs a wake-up, and the wake-up must not be a message in the
 * room — most hand-backs are somebody looking at a page, not a task, and a
 * "the browser was handed back" post in every conversation is exactly the
 * bothering nobody wants. So the kickoff is a `system` message: kept for audit
 * and restart replay, excluded from the channel feed and from later model
 * context, and still the run's prompt. The same shape a trigger fire uses
 * (`trigger-dispatch.ts`).
 *
 * The agent decides whether any of it matters. If it has nothing to do it says
 * nothing, the session's idle window closes, and the browser winds down — no
 * post, no notification, nothing for the person to dismiss.
 */

/** What the agent is told. Its own judgement is the point, so it is asked. */
const handoverPrompt = (input: {
  agentName: string
  tabs: Array<{ title: string; url: string }>
}): string => {
  const where = input.tabs.length === 0
    ? 'The browser has no pages open.'
    : `The browser is now on:\n${input.tabs
      .map((tab) => `- ${tab.title || 'Untitled'} — ${tab.url}`)
      .join('\n')}`
  return [
    'A person has just finished using your browser and handed it back to you.',
    'They may have signed you in to something you asked for, or they may have',
    'simply been looking at a page — you cannot see what they did while they',
    'held the controls.',
    '',
    where,
    '',
    'Decide for yourself whether this changes anything for the work you were',
    'doing. If it does, carry on with it. If it does not — if this looks like',
    'somebody browsing rather than finishing a task you were waiting on — then',
    'say nothing at all and stop. Staying quiet is the right answer more often',
    'than not, and an unnecessary message is worse than silence.',
  ].join('\n')
}

export type BrowserHandoverInput = {
  actorContext: AuthorizedActionContext
  agentId: string
  agentBrowserId: string
  agentName: string
  byUserId: string
  channelId: string
  organizationId: string
  tabs: Array<{ title: string; url: string }>
  threadId: string
}

/**
 * Returns the run it started, or null when one was already in flight for this
 * agent in this thread — `claimThreadRunOrPend` then batches the kickoff into
 * that run's follow-up rather than opening a second one, exactly as a trigger
 * fire does.
 */
export const nudgeAgentAfterHandover = async (
  prisma: PrismaClient,
  input: BrowserHandoverInput,
): Promise<{ runId: string } | null> =>
  prisma.$transaction(async (tx) => {
    const message = await createSystemAuthoredMessage(tx, {
      content: handoverPrompt({ agentName: input.agentName, tabs: input.tabs }),
      // Nobody is following a kickoff nobody can see.
      followedByUserIds: [],
      // Never a post a person made. `system` keeps the row for audit and
      // restart replay while excluding it from the channel feed and from
      // later model context; the run still receives this content as its
      // prompt through `payload.messageId`, which ignores role.
      role: 'system',
      threadId: input.threadId,
    })

    const claim = await claimThreadRunOrPend(tx, {
      agentId: input.agentId,
      threadId: input.threadId,
      pending: {
        actorContext: input.actorContext,
        channelId: input.channelId,
        // Handing a browser back is a button press, not a conversational
        // turn. `interactive` decides delegated identity, agent handoff, app
        // setup and whether the budget treats this as a human — none of which
        // a person who has walked away should be granting. The one capability
        // this run does need travels as `browserHandback` instead.
        interactive: false,
        messageId: message.id,
      },
    })
    if (claim !== 'claimed') return null

    const run = await tx.run.create({
      data: {
        agentId: input.agentId,
        // The kickoff is hidden, so threading a reply under it would drop the
        // reply out of the room entirely — the same pairing a trigger uses.
        replyPlacement: 'channel',
        status: 'pending',
        threadId: input.threadId,
      },
      select: { id: true },
    })
    const task = await tx.task.create({
      data: {
        agentId: input.agentId,
        organizationId: input.organizationId,
        purpose: 'Browser handed back',
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    await enqueueRunExecution(
      tx,
      {
        actorContext: {
          ...input.actorContext,
          actionContext: {
            ...input.actorContext.actionContext,
            agentId: input.agentId,
            channelId: input.channelId,
            taskId: task.id,
            threadId: input.threadId,
          },
        },
        agentId: input.agentId,
        // The whole reason this run may touch a signed-in browser, and the
        // only thing it may do with that permission.
        browserHandback: {
          agentBrowserId: input.agentBrowserId,
          byUserId: input.byUserId,
        },
        interactive: false,
        messageId: message.id,
        runId: run.id,
        taskId: task.id,
        threadId: input.threadId,
      } as Parameters<typeof enqueueRunExecution>[1],
      `run:${run.id}`,
    )
    return { runId: run.id }
  })
