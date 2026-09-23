import { deepWaterFailureMessage } from '@nessie/runtime'
import type {
  DeepWaterDeliveryBlockedReason,
  DeepWaterNoticeKind,
  DeepWaterReportKind,
  DeepWaterTurnRegister,
} from '@nessie/schemas'

// One table of failure reasons for the views and the notices (`@nessie/runtime`).
export { deepWaterFailureMessage }

/**
 * The words DeepWater's delivery uses: the hidden kickoffs that wake an agent
 * (model-facing, so they name its tools), and the notices a person reads
 * (UK English, plain, second person, and never a vendor, model, price or
 * infrastructure name). Kickoffs are structural: they never quote the
 * planner's reply or the report, which the agent reads through its own tools.
 */

const quoted = (topic: string): string => `“${topic}”`

const reportWord = (kind: DeepWaterReportKind | null): string =>
  kind === 'full' ? 'full report' : kind === 'summary' ? 'research summary' : 'report'

export const turnKickoff = (input: { topic: string; researchId: string; turn: DeepWaterTurnRegister }): string => {
  const about = `the brief for ${quoted(input.topic)} (research id ${input.researchId})`
  if (input.turn.status === 'failed') {
    return `DeepWater's research planner could not answer ${about}. `
      + (input.turn.retryable
        ? 'Send your reply again with mcp_research_scope_reply.'
        : 'Tell the person who asked.')
  }
  return `DeepWater's research planner answered ${about}. Read it with mcp_research_scope_get `
    + '(leave include_transcript off unless you need the whole conversation), then continue: '
    + 'reply with mcp_research_scope_reply, ask the person with card_post and wait: true if only '
    + 'they can answer, or launch with mcp_research_scope_launch using the current revision.'
}

export const completedKickoff = (input: {
  sourceCount: number
  pageId: string
  reportKind: DeepWaterReportKind | null
}): string => {
  const sources = `${input.sourceCount} source${input.sourceCount === 1 ? '' : 's'}`
  const where = `/knowledge-base?pageId=${input.pageId}`
  if (input.reportKind === 'summary') {
    return `The DeepWater research you started here has finished (${sources}), but its full report `
      + `could not be written; the research summary is saved in Documents: ${where}. Read it with `
      + 'kb_read, then tell the person who asked that they have the summary, not the full report. '
      + 'Do not start the same research again unless they ask.'
  }
  return `The DeepWater research you started here has finished (${sources}). The `
    + `${reportWord(input.reportKind)} is saved in Documents: ${where}. Read it with kb_read before `
    + 'relying on it, then carry on and answer the person who asked, here. Do not start the same '
    + 'research again.'
}

export const failedKickoff = (input: { topic: string; failureCode: string | null }): string =>
  `The DeepWater research you started here for ${quoted(input.topic)} did not finish: `
  + `${deepWaterFailureMessage(input.failureCode)}. Tell the person who asked; start a new brief `
  + 'only if they still need it.'

export const startUnconfirmedKickoff = (topic: string): string =>
  `DeepWater did not confirm the research brief you opened here for ${quoted(topic)}. Tell the `
  + 'person who asked; open a new brief only if they still need it.'

export const resultNotice = (input: {
  topic: string
  sourceCount: number
  pageId: string
  spaceId: string
  reportKind: DeepWaterReportKind | null
  truncated: boolean
}): string => {
  const sources = `${input.sourceCount} source${input.sourceCount === 1 ? '' : 's'}`
  const link = `/knowledge-base?spaceId=${input.spaceId}&pageId=${input.pageId}`
  const lead = input.reportKind === 'summary'
    ? `Your DeepWater research ${quoted(input.topic)} has finished (${sources}), but the full report `
      + `couldn't be written. The research summary is in Documents: [open it](${link}).`
    : `Your DeepWater research ${quoted(input.topic)} has finished (${sources}). The `
      + `${reportWord(input.reportKind)} is in Documents: [open it](${link}).`
  return input.truncated
    ? `${lead} It was too long to keep in full, so the end of it is missing.`
    : lead
}

export const failedNotice = (input: { topic: string; failureCode: string | null }): string =>
  `Your DeepWater research ${quoted(input.topic)} didn't finish: `
  + `${deepWaterFailureMessage(input.failureCode)}. Start it again when you're ready.`

export const startUnconfirmedNotice = (topic: string): string =>
  `DeepWater didn't confirm your research brief for ${quoted(topic)}. Open a new brief if you still `
  + 'need this research.'

const BLOCKED_REMEDY: Record<DeepWaterDeliveryBlockedReason, string> = {
  requester_identity_changed:
    'your sign-in has changed since you asked for it. Sign in again, then choose Retry import on the research',
  ledger_unavailable: 'DeepWater couldn\'t hand the report over just now. Choose Retry import on the research',
  // Posted only while the conversation is there to hold it (a conversation that
  // is gone cannot be told anything), so the cause is always the page itself,
  // and Retry import restores it (`restoreDeepWaterReportPage`).
  knowledge_destination_unavailable:
    'its page there was deleted or changed before the result could be shared here. Choose Retry import on '
    + 'the research to put the page back',
  report_expired: 'the report is no longer available to import',
  report_malformed: 'the report couldn\'t be read',
}

/** A finished research that could not be delivered: what happened and the one remedy. */
export const blockedNotice = (input: { topic: string; reason: DeepWaterDeliveryBlockedReason }): string =>
  `Your DeepWater research ${quoted(input.topic)} has finished, but it couldn't be saved to Documents: `
  + `${BLOCKED_REMEDY[input.reason]}.`

/**
 * The requester's sign-in changed while their research is still running
 * (amendments-fable F4): nothing has finished or failed to save yet, DeepWater
 * just can no longer be asked about it for them until they act again.
 */
export const identityChangedWhileRunningNotice = (topic: string): string =>
  `DeepWater can't check on your research ${quoted(topic)} because your sign-in has changed. `
  + 'Sign in again, then choose Retry on the research, so its result still comes back here.'

/**
 * The same, for a brief an agent is still agreeing for the person: the agent
 * cannot be told what the planner says until they act, and nothing else would
 * tell them — a person's own brief says so in its dialog instead.
 */
export const identityChangedOnAgentBriefNotice = (topic: string): string =>
  `The agent working on your DeepWater research brief ${quoted(topic)} can't carry on because `
  + 'your sign-in has changed. Sign in again, then choose Retry on the research so the agent can continue.'

export const wakeUnreachableNotice = (input: { topic: string; finished: boolean; link: string | null }): string =>
  input.finished && input.link
    ? `The DeepWater research you asked an agent for, ${quoted(input.topic)}, has finished, but the `
      + `agent couldn't be told. The report is in Documents: [open it](${input.link}).`
    : `The agent working on your DeepWater research brief ${quoted(input.topic)} couldn't be told `
      + 'what the research planner said. Ask it to carry on, or open a new brief yourself.'

export const wakeCapNotice = (topic: string): string =>
  `The agent working on your DeepWater research brief ${quoted(topic)} has gone back and forth with `
  + 'the research planner many times without starting the research. Ask it to start or stop the brief.'

const NOTICE_PUSH_BODY: Record<DeepWaterNoticeKind, string> = {
  result: 'Your DeepWater research has finished.',
  failed: 'Your DeepWater research didn\'t finish.',
  blocked: 'Your DeepWater research needs you before it can be saved.',
  start_unconfirmed: 'DeepWater didn\'t confirm your research brief.',
  wake_unreachable: 'There\'s news about your DeepWater research.',
  wake_cap: 'Your DeepWater research brief needs you.',
}

/**
 * What a lock screen shows for a notice whose words it may not show (one
 * drawn on sources the room does not imply): what kind of news it is, never
 * the topic or anything from the research.
 */
export const noticePushBody = (kind: DeepWaterNoticeKind): string => NOTICE_PUSH_BODY[kind]
