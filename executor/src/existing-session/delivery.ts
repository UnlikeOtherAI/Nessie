import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { CodingBridgeError } from '../coding-session/bridge-tools.js'
import { createJsonExclusive, ensureCodingStateDir, readJson, writeJsonAtomic } from '../coding-session/session-files.js'

type Delivery = { fingerprint: string; result: Record<string, unknown> }

/** Claim before provider I/O. A crash after the claim yields unknown, never an automatic duplicate. */
export const deliverOnce = async (input: {
  stateDir: string
  commandId: string
  ownerKey: string
  sessionId: string
  action: string
  message: string
  send: () => Promise<Record<string, unknown>>
}): Promise<Record<string, unknown>> => {
  const directory = join(input.stateDir, 'existing-deliveries')
  await ensureCodingStateDir(directory)
  const key = createHash('sha256').update(input.commandId).digest('hex')
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.ownerKey, input.sessionId, input.action, input.message])).digest('hex')
  const path = join(directory, `${key}.json`)
  const unknown = { sessionId: input.sessionId, state: 'outcome_unknown', providerMessageId: input.commandId }
  if (!await createJsonExclusive(path, { fingerprint, result: unknown })) {
    const prior = await readJson<Delivery>(path)
    if (prior?.fingerprint !== fingerprint) {
      throw new CodingBridgeError('coding_session_command_conflict', 'This command ID was already used for another action.')
    }
    return prior.result
  }
  const result = await input.send().catch(() => unknown)
  const answer = { ...result, sessionId: input.sessionId }
  await writeJsonAtomic(path, { fingerprint, result: answer })
  return answer
}
