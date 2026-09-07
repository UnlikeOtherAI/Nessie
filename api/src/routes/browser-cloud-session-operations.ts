import type { PrismaClient } from '@prisma/client'

import {
  BROWSER_HOMEPAGE_SETTING_KEY,
  resolveBrowserHomepage,
} from '@nessie/schemas'
import { resolveScopedSetting } from '@nessie/runtime'

import { findThreadForUser } from '../services/message-read-state.js'
/** Resolves server-owned browser settings for the guarded canvas. */
export const createBrowserSessionOperations = (
  prisma: PrismaClient,
) => ({
  async homepageFor(input: {
    organizationId: string
    threadId: string
    userId: string
  }): Promise<string> {
    const thread = await findThreadForUser(
      prisma,
      input.threadId,
      input.userId,
      input.organizationId,
    )
    const channel = thread
      ? await prisma.channel.findUnique({
        select: { teamId: true },
        where: { id: thread.channel.id },
      })
      : null
    const resolved = await resolveScopedSetting(
      prisma,
      {
        organizationId: input.organizationId,
        teamId: channel?.teamId ?? null,
        userId: input.userId,
      },
      BROWSER_HOMEPAGE_SETTING_KEY,
    )
    return resolveBrowserHomepage(resolved.value)
  },
})

export type BrowserSessionOperations = ReturnType<typeof createBrowserSessionOperations>
