import { readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson, writeJsonAtomic } from '../coding-session/session-files.js'
import { existingAuthorityIsLive } from './authority.js'
import { channelInboxDir, type ChannelEvent } from './channel-files.js'
import { existingSessionsEnabled } from './settings.js'

/** Claim each event before provider I/O; a failed write stays claimed and is never automatically replayed. */
export const drainClaudeChannel = async (input: {
  stateDir: string
  sessionId: string
  incarnation: string
  notify: (event: ChannelEvent) => Promise<void>
}): Promise<void> => {
  const inbox = channelInboxDir(input.stateDir, input.sessionId)
  const files = (await readdir(inbox)).filter((name) => /^[a-f0-9-]+\.pending$/u.test(name)).sort().slice(0, 32)
  const events = await Promise.all(files.map(async (name) => ({
    path: join(inbox, name), event: await readJson<ChannelEvent>(join(inbox, name)),
  })))
  events.sort((left, right) => (left.event?.queuedAt ?? 0) - (right.event?.queuedAt ?? 0))
  for (const { path, event } of events) {
    if (!event) { await unlink(path); continue }
    const enabled = await existingSessionsEnabled(input.stateDir) && await existingAuthorityIsLive(input.stateDir)
    const valid = enabled && event.sessionId === input.sessionId && event.incarnation === input.incarnation
      && event.expiresAt > Date.now() && typeof event.message === 'string' && event.message.length <= 33_000
    const claimed = path.replace(/\.pending$/u, '.claimed')
    const resultPath = path.replace(/\.pending$/u, '.result')
    await rename(path, claimed)
    if (!valid) {
      await writeJsonAtomic(resultPath, { state: 'cancelled', providerMessageId: event.commandId })
      await unlink(claimed)
      continue
    }
    await input.notify(event)
    await writeJsonAtomic(resultPath, { state: 'written_to_transport', providerMessageId: event.commandId,
      behavior: 'Claude received an MCP channel notification; consumption is not acknowledged.' })
    await unlink(claimed)
  }
}
