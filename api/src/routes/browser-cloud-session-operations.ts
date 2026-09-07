import type { PrismaClient } from '@prisma/client'

import {
  BROWSER_HOMEPAGE_SETTING_KEY,
  resolveBrowserHomepage,
  type BrowserViewport,
} from '@nessie/schemas'
import { resolveScopedSetting } from '@nessie/runtime'

import { findThreadForUser } from '../services/message-read-state.js'
import { withLiveBrowserSession } from './browser-cloud-live-session.js'

/** The small set of provider operations shared by browser HTTP routes. */
export const createBrowserSessionOperations = (
  prisma: PrismaClient,
  encryptionSecret: string,
) => ({
  async resize(input: { sessionId: string; viewport: BrowserViewport }): Promise<boolean> {
    const done = await withLiveBrowserSession(prisma, {
      encryptionSecret,
      sessionId: input.sessionId,
    }, async (cdp) => {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 0,
        height: input.viewport.height,
        mobile: false,
        width: input.viewport.width,
      })
      return true
    })
    return done === true
  },

  async navigate(input: { sessionId: string; url: string }): Promise<boolean> {
    const done = await withLiveBrowserSession(prisma, {
      encryptionSecret,
      sessionId: input.sessionId,
    }, async (cdp) => {
      await cdp.call('Page.navigate', { url: input.url })
      return true
    })
    return done === true
  },

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
