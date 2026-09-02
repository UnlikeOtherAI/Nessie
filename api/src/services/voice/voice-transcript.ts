import { Readable } from 'node:stream'

import type { PrismaClient, VoiceSession } from '@prisma/client'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import type { AuthorizedActionContext, VoiceTranscriptLine } from '@nessie/schemas'

import { VoiceSessionError } from './voice-session.js'

/**
 * The one durable record a call leaves behind.
 *
 * Shape decided by three constraints that ruled out the obvious design:
 *
 * 1. A `user`-role message would structurally wake the Personal Assistant —
 *    every human turn in a PA DM is addressed to it (`resolvePersonalAssistant
 *    Decisions` replies to each one) — so each hang-up would spawn a billed run
 *    answering its own call record. The record is therefore written in the
 *    assistant's own voice, the role that path returns no decisions for.
 * 2. A message carries exactly one role, and a transcript carries two
 *    speakers. Storing mixed speaker lines as message *content* would make
 *    either the assistant's words read as the person's instructions or the
 *    person's words read as the assistant's assertions. The transcript is
 *    therefore an attachment of labelled lines, not role-bearing turns.
 * 3. Message content caps at 4,000 characters.
 *
 * So: a short summary in the message, the full transcript beside it as a
 * markdown file, and one collapsed call card in the feed that expands to it.
 */

/** Inline summary ceiling, comfortably under the 4,000-character message cap. */
const SUMMARY_MAX_CHARS = 3_500

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds}s`
}

const formatTimestamp = (atMs: number): string => {
  const totalSeconds = Math.floor(atMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The markdown file holding every spoken line.
 *
 * Speakers are labelled in text rather than encoded as roles, which is what
 * keeps the assistant's later reads of this file observations rather than
 * instructions.
 */
export const renderTranscriptMarkdown = (input: {
  agentName: string
  durationMs: number
  lines: VoiceTranscriptLine[]
  startedAt: Date
  userDisplayName: string
}): string => {
  const header = [
    `# Voice call with ${input.agentName}`,
    '',
    `- Started: ${input.startedAt.toISOString()}`,
    `- Duration: ${formatDuration(input.durationMs)}`,
    `- Turns: ${input.lines.length}`,
    '',
    '_Transcribed on the caller’s device during the call._',
    '',
    '---',
    '',
  ].join('\n')

  const body = input.lines
    .map((line) => {
      const speaker = line.speaker === 'user' ? input.userDisplayName : input.agentName
      return `**${formatTimestamp(line.atMs)} ${speaker}:** ${line.text}`
    })
    .join('\n\n')

  return `${header}${body}\n`
}

/**
 * The message body: what the call was, at a glance.
 *
 * This is the part that enters the assistant's later context windows, so it
 * stays short and leads with the opening exchange — enough for "as we
 * discussed on the call" to resolve, without the whole transcript riding along
 * in every future prompt.
 */
export const renderCallSummary = (input: {
  durationMs: number
  lines: VoiceTranscriptLine[]
  hasAttachment: boolean
}): string => {
  const turns = input.lines.length
  const opening = [
    `Voice call · ${formatDuration(input.durationMs)} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`,
  ]
  if (turns === 0) {
    opening.push('', 'Nothing was said before the call ended.')
    return opening.join('\n')
  }

  opening.push('')
  let used = opening.join('\n').length
  const rendered: string[] = []
  for (const line of input.lines) {
    const speaker = line.speaker === 'user' ? 'You' : 'Assistant'
    const entry = `${speaker}: ${line.text}`
    if (used + entry.length + 2 > SUMMARY_MAX_CHARS) {
      rendered.push('…')
      break
    }
    rendered.push(entry)
    used += entry.length + 2
  }

  const tail = input.hasAttachment ? ['', 'Full transcript attached.'] : []
  return [...opening, ...rendered, ...tail].join('\n')
}

export type WriteCallRecordInput = {
  actorContext: AuthorizedActionContext
  agentName: string
  durationMs: number
  fileService: FileService
  lines: VoiceTranscriptLine[]
  session: VoiceSession
  userDisplayName: string
}

/**
 * Writes the call record, once.
 *
 * The transcript slot is claimed by a conditional update before anything is
 * written, so a retried submission (or two tabs racing a hang-up) resolves to
 * exactly one record rather than two.
 *
 * Deliberate omissions versus the ordinary message-create path, each because
 * the record is not a turn in a conversation: no orchestrator decide job (the
 * whole point — nobody addressed this to the assistant), no push (the only
 * recipient just hung up), no mention parsing (the text is server-authored).
 * Realtime publication is the caller's job, so the feed still updates live.
 */
export const writeVoiceCallRecord = async (
  prisma: PrismaClient,
  input: WriteCallRecordInput,
): Promise<{ messageId: string; attachmentId: string | null }> => {
  // The claim is `active → ended`, with both the status and the empty
  // transcript slot in the WHERE: a second submission (a retry, or two tabs
  // racing a hang-up) fails to match and loses here, before it can write a
  // second message. Checking `status` in a prior read would not do it —
  // read-then-write is not a claim.
  const claimed = await prisma.voiceSession.updateMany({
    where: { id: input.session.id, status: 'active', transcriptMessageId: null },
    data: { status: 'ended', endedAt: new Date() },
  })
  if (claimed.count !== 1) {
    throw new VoiceSessionError(
      'VOICE_TRANSCRIPT_ALREADY_RECORDED',
      'This call already has a record.',
      409,
    )
  }

  // Storing the transcript needs the message to exist (attachments link to
  // one), so the message is created first and the attachment linked after.
  const hasTranscript = input.lines.length > 0
  const message = await prisma.message.create({
    data: {
      threadId: input.session.threadId,
      agentId: input.session.agentId,
      role: 'assistant',
      content: renderCallSummary({
        durationMs: input.durationMs,
        lines: input.lines,
        hasAttachment: hasTranscript,
      }),
      metadata: {
        voiceCall: {
          voiceSessionId: input.session.id,
          durationMs: input.durationMs,
          turnCount: input.lines.length,
          transcriptAttachmentId: null,
        },
      },
    },
  })

  let attachmentId: string | null = null
  if (hasTranscript) {
    const markdown = renderTranscriptMarkdown({
      agentName: input.agentName,
      durationMs: input.durationMs,
      lines: input.lines,
      startedAt: input.session.startedAt,
      userDisplayName: input.userDisplayName,
    })
    const stored = await input.fileService.store({
      attribution: attributionFromActorContext(input.actorContext, {
        agentId: input.session.agentId,
        agentKind: 'personal_assistant',
        systemComponent: 'voice-call',
      }),
      organizationId: input.session.organizationId,
      uploaderId: input.session.userId,
      filename: `voice-call-${input.session.startedAt.toISOString().slice(0, 19).replace(/[:T]/gu, '-')}.md`,
      mime: 'text/markdown',
      body: Readable.from([Buffer.from(markdown, 'utf8')]),
      messageId: message.id,
    })
    attachmentId = stored.attachment.id
    await prisma.message.update({
      where: { id: message.id },
      data: {
        metadata: {
          voiceCall: {
            voiceSessionId: input.session.id,
            durationMs: input.durationMs,
            turnCount: input.lines.length,
            transcriptAttachmentId: attachmentId,
          },
        },
      },
    })
  }

  await prisma.voiceSession.update({
    where: { id: input.session.id },
    data: { transcriptMessageId: message.id },
  })

  return { messageId: message.id, attachmentId }
}

/**
 * Refuses a transcript for a call that never spoke to Google.
 *
 * The lines are client-reported — only the client heard the audio — so the one
 * server-side fact available to sanity-check them is whether this session ever
 * relayed a usage turn. A transcript for a session with no turns is either a
 * bug or a fabrication, and neither belongs in the conversation.
 */
export const assertTranscriptPlausible = (
  session: VoiceSession,
  lines: VoiceTranscriptLine[],
): void => {
  if (lines.length > 0 && session.lastUsageSequence === 0) {
    throw new VoiceSessionError(
      'VOICE_TRANSCRIPT_UNSUPPORTED',
      'This call reported no conversation turns, so its transcript cannot be recorded.',
      409,
    )
  }
}
