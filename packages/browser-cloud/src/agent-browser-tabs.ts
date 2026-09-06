import { Prisma, type PrismaClient } from '@prisma/client'

import { connectCdp, type CdpClient } from './cdp-client.js'
import { loadSessionCapability } from './session-capability.js'

/**
 * The tabs an agent's browser was last seen with.
 *
 * A Browserbase session is gone the moment it is released, and with it every
 * page it had open. What a person opening the chat's Browser panel wants is
 * not "nothing to watch" but where the browser left off — what it was on,
 * what that looked like — and what a resume needs is the addresses to go
 * back to. Both come from here: a set of rows per durable browser, rewritten
 * on every capture, so it is always the latest state and never a history.
 */

/** `Uint8Array<ArrayBuffer>` because that is the exact shape Prisma's `Bytes` takes. */
export type ScreenshotBytes = Uint8Array<ArrayBuffer>

export type CapturedTab = {
  position: number
  url: string
  title: string
  screenshot: ScreenshotBytes | null
  screenshotMime: string | null
}

export type AgentBrowserTabRecord = {
  id: string
  position: number
  url: string
  title: string
  capturedAt: string | null
  /** The screenshot inline, small enough for that to be the sensible transport. */
  screenshotDataUrl: string | null
}

/**
 * No more than this many tabs are kept. A browser with more has a runaway
 * agent behind it, and the panel that shows them fits about this many.
 */
export const AGENT_BROWSER_TAB_LIMIT = 12

/**
 * The capture is a picture, not a record: the page's viewport as a JPEG at
 * reduced quality, which on a typical page lands around 40–120 KB. Above the
 * cap the tab keeps its address and title and loses only the picture.
 */
export const SCREENSHOT_MAX_BYTES = 400_000

/**
 * The whole of a capture — dial, attach, every page — must fit in this,
 * because a capture stands in front of things that matter more: the agent's
 * next verb, and the release that stops the billing.
 */
export const CAPTURE_TIMEOUT_MS = 10_000

const SCREENSHOT_MIME = 'image/jpeg'

/** Chrome's start page and a blank tab say nothing worth keeping. */
const isNoisePage = (url: string): boolean =>
  url === '' || url === 'about:blank' || url.startsWith('chrome://')

const base64ToBytes = (data: string): ScreenshotBytes =>
  Uint8Array.from(Buffer.from(data, 'base64'))

const withTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T | null> =>
  Promise.race([
    work,
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), timeoutMs).unref?.() }),
  ])

const screenshotOf = async (
  cdp: CdpClient,
  sessionId: string,
  background: boolean,
): Promise<ScreenshotBytes | null> => {
  for (const quality of [55, 30]) {
    const shot = await cdp.call(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality,
        optimizeForSpeed: true,
        // A page that is not in front has no surface to read; asking the
        // renderer directly is what gives a background tab a picture at all.
        // Unverified against Browserbase — if it comes back blank, the tab
        // still keeps its address, which is what a resume is built from.
        ...(background ? { fromSurface: false } : {}),
      },
      { sessionId },
    )
    if (typeof shot.data !== 'string') return null
    const bytes = base64ToBytes(shot.data)
    if (bytes.byteLength <= SCREENSHOT_MAX_BYTES) return bytes
  }
  return null
}

/**
 * Every page the browser has open, in target order, each with a screenshot
 * when one could be taken.
 *
 * Each page is attached to for the capture and detached again: the client's
 * own attachment is the page the agent drives, and this must not disturb it.
 * A page whose capture fails keeps its address — a picture is a nicety, the
 * address is what a resume is built from.
 */
export const snapshotBrowserTabs = async (
  cdp: CdpClient,
  options: { withScreenshots?: boolean } = {},
): Promise<CapturedTab[]> => {
  const pages = (await cdp.targets())
    .filter((target) => target.type === 'page' && !isNoisePage(target.url))
    .slice(0, AGENT_BROWSER_TAB_LIMIT)
  const tabs: CapturedTab[] = []
  for (const [position, page] of pages.entries()) {
    let screenshot: ScreenshotBytes | null = null
    if (options.withScreenshots !== false) {
      try {
        const attached = await cdp.call(
          'Target.attachToTarget',
          { targetId: page.targetId, flatten: true },
          { sessionId: null },
        )
        const sessionId = attached.sessionId
        if (typeof sessionId === 'string') {
          try {
            screenshot = await screenshotOf(cdp, sessionId, position > 0)
          } finally {
            await cdp
              .call('Target.detachFromTarget', { sessionId }, { sessionId: null })
              .catch(() => undefined)
          }
        }
      } catch {
        screenshot = null
      }
    }
    tabs.push({
      position,
      url: page.url,
      title: page.title,
      screenshot,
      screenshotMime: screenshot ? SCREENSHOT_MIME : null,
    })
  }
  return tabs
}

/**
 * Replace the browser's stored tabs with this set. A set, not a merge: the
 * rows describe the browser as it is now, and a tab the agent closed must not
 * linger as one it still has.
 *
 * Under a per-browser advisory lock, because captures overlap: a capture that
 * outran its timeout is still writing when the next verb's capture starts,
 * a hand-back can land beside a release, and delete-all-then-insert under a
 * unique index turns that into an aborted transaction — or an older picture
 * committing after a newer one.
 */
export const persistAgentBrowserTabs = async (
  prisma: Pick<PrismaClient, '$transaction'>,
  input: { organizationId: string; agentBrowserId: string; tabs: CapturedTab[]; now?: Date },
): Promise<void> => {
  const now = input.now ?? new Date()
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-browser-tabs:${input.agentBrowserId}`}, 0))`,
    )
    await tx.agentBrowserTab.deleteMany({ where: { agentBrowserId: input.agentBrowserId } })
    if (input.tabs.length === 0) return
    await tx.agentBrowserTab.createMany({
      data: input.tabs.map((tab) => ({
        organizationId: input.organizationId,
        agentBrowserId: input.agentBrowserId,
        position: tab.position,
        url: tab.url,
        title: tab.title,
        screenshot: tab.screenshot,
        screenshotMime: tab.screenshotMime,
        // The row was seen now whether or not its picture came out; "seen"
        // is about the address, and a tab over the byte cap still has one.
        capturedAt: now,
      })),
    })
  })
}

export const listAgentBrowserTabs = async (
  prisma: Pick<PrismaClient, 'agentBrowserTab'>,
  input: { organizationId: string; agentBrowserId: string },
): Promise<AgentBrowserTabRecord[]> => {
  const rows = await prisma.agentBrowserTab.findMany({
    where: { organizationId: input.organizationId, agentBrowserId: input.agentBrowserId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      position: true,
      url: true,
      title: true,
      capturedAt: true,
      screenshot: true,
      screenshotMime: true,
    },
  })
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    url: row.url,
    title: row.title,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    screenshotDataUrl:
      row.screenshot && row.screenshotMime
        ? `data:${row.screenshotMime};base64,${Buffer.from(row.screenshot).toString('base64')}`
        : null,
  }))
}

/**
 * Put a fresh session back the way its browser was left.
 *
 * The first stored tab goes into the page the client is attached to — the one
 * the agent's verbs drive, which is why position 0 is that page — and every
 * other tab opens behind it. Navigation is not awaited to completion: a page
 * that is slow to load must not hold the resume, and the live view shows it
 * loading.
 */
export const restoreBrowserTabs = async (
  cdp: CdpClient,
  tabs: ReadonlyArray<{ url: string }>,
): Promise<number> => {
  const [first, ...rest] = tabs
  if (!first) return 0
  await cdp.call('Page.navigate', { url: first.url })
  let restored = 1
  for (const tab of rest) {
    try {
      await cdp.call(
        'Target.createTarget',
        { url: tab.url, background: true },
        { sessionId: null },
      )
      restored += 1
    } catch {
      // One unreachable address must not cost the rest of the browser.
    }
  }
  return restored
}

/**
 * Capture a live session's tabs into its durable browser, over a socket the
 * caller already holds. Bounded and never throws — see `CAPTURE_TIMEOUT_MS`.
 * An ephemeral session has no durable browser and nothing to capture into.
 */
export const captureSessionTabs = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession' | '$transaction'>,
  input: { sessionId: string; cdp: CdpClient; withScreenshots?: boolean },
): Promise<boolean> => {
  const session = await prisma.cloudBrowserSession.findUnique({
    where: { id: input.sessionId },
    select: { organizationId: true, agentBrowserId: true },
  })
  if (!session?.agentBrowserId) return false
  const { agentBrowserId, organizationId } = session
  try {
    const tabs = await withTimeout(
      snapshotBrowserTabs(input.cdp, { withScreenshots: input.withScreenshots }),
      CAPTURE_TIMEOUT_MS,
    )
    if (tabs === null) return false
    await persistAgentBrowserTabs(prisma, { organizationId, agentBrowserId, tabs })
    return true
  } catch {
    return false
  }
}

/**
 * Capture over a socket of our own, for a session nobody is driving.
 *
 * A run's session is captured over its worker's socket (`session-pool.ts`
 * says why a second connection is not an option there). A resumed session has
 * no worker, so this dials the connect URL, takes the pictures, and hangs up
 * — the dial and the attach inside the same bound as the pictures, because a
 * hung dial in front of a release would keep the browser billing.
 */
export const captureTabsAtConnectUrl = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession' | '$transaction'>,
  input: {
    sessionId: string
    connectUrl: string
    connect?: (connectUrl: string) => Promise<CdpClient>
  },
): Promise<boolean> => {
  let cdp: CdpClient | null = null
  try {
    const captured = await withTimeout((async () => {
      cdp = await (input.connect ?? connectCdp)(input.connectUrl)
      await cdp.attachToPage()
      return captureSessionTabs(prisma, { cdp, sessionId: input.sessionId })
    })(), CAPTURE_TIMEOUT_MS)
    return captured === true
  } catch {
    return false
  } finally {
    // `cdp` is assigned inside the raced closure; the cast is for the checker,
    // which cannot see past the IIFE.
    ;(cdp as CdpClient | null)?.close()
  }
}

/**
 * The same, for a session whose capability is still on its row — used when
 * a person hands the controls back, which is "I'm done" on a resumed session.
 */
export const captureUndrivenSessionTabs = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession' | '$transaction'>,
  input: {
    sessionId: string
    encryptionSecret: string
    connect?: (connectUrl: string) => Promise<CdpClient>
  },
): Promise<boolean> => {
  if (!input.encryptionSecret) {
    // Silent skipping here would look, from the panel, like a browser that
    // never saves — so the misconfiguration is named where an operator reads.
    console.warn('[browser-cloud] no auth secret configured; a resumed session’s tabs cannot be captured')
    return false
  }
  const capability = await loadSessionCapability(prisma, {
    sessionId: input.sessionId,
    encryptionSecret: input.encryptionSecret,
  })
  if (!capability) return false
  return captureTabsAtConnectUrl(prisma, {
    sessionId: input.sessionId,
    connectUrl: capability.connectUrl,
    connect: input.connect,
  })
}
