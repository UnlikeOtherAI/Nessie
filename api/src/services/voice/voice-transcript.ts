import { Readable } from 'node:stream'

import type { Prisma, PrismaClient, VoiceSession } from '@prisma/client'
import {
  attributionFromActorContext,
  type FileService,
  type ModelClient,
} from '@nessie/runtime'
import {
  redactDetectedSecrets,
  type AuthorizedActionContext,
  type VoiceTranscriptLine,
} from '@nessie/schemas'

import { compactCallTranscript } from './voice-compaction.js'
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
 *
 * Two artefacts, on purpose. The **attachment** is the verbatim ground truth,
 * read on demand. The **message content** is a generated compaction — what was
 * discussed and decided, every substantive detail kept and the conversational
 * noise dropped — because that text is what the assistant carries in every
 * later context window, and raw turns meant carrying the filler forever.
 * Compaction fails open to the verbatim summary below (see
 * {@link ./voice-compaction.ts}).
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
 * The first line of every call record: what this was, at a glance.
 *
 * The admin's call card reads it as the card's title, so both shapes of record
 * — compacted and fallback — have to open with it.
 */
const renderCallHeader = (durationMs: number, turns: number): string =>
  `Voice call · ${formatDuration(durationMs)} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`

/**
 * The message body when compaction succeeded: the header, then prose.
 *
 * Nothing here says the transcript is attached. The attachment inventory line
 * the run pipeline appends already tells the model that, and the card offers a
 * real control rather than a sentence about one.
 */
export const renderCompactedCallSummary = (input: {
  compaction: string
  durationMs: number
  turnCount: number
}): string =>
  [renderCallHeader(input.durationMs, input.turnCount), '', input.compaction].join('\n')

/**
 * The message body when compaction is unavailable: the spoken turns, verbatim,
 * until the cap.
 *
 * Noisier than a compaction and the reason compaction exists — but a record
 * that carries the filler is enormously better than no record at all, so this
 * is what every failure falls back to.
 */
export const renderCallSummary = (input: {
  durationMs: number
  lines: VoiceTranscriptLine[]
}): string => {
  const turns = input.lines.length
  const opening = [renderCallHeader(input.durationMs, turns)]
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

  // No closing note about the attachment. The card carries a **Full
  // transcript** button that says it better, and printing the sentence one
  // line above that button said it twice; the model learns the transcript
  // exists from the attachment inventory line appended at render time, not
  // from prose here.
  return [...opening, ...rendered].join('\n')
}

export type WriteCallRecordInput = {
  actorContext: AuthorizedActionContext
  agentName: string
  durationMs: number
  fileService: FileService
  lines: VoiceTranscriptLine[]
  /** Absent on a deployment with no model service; the record still lands. */
  modelClient: ModelClient | null
  session: VoiceSession
  userDisplayName: string
  /** Surfaces a failed compaction in the log rather than only in metadata. */
  onCompactionFailure?: (error: unknown) => void
  /**
   * Surfaces a transcript whose bytes could not be freed after the record
   * failed to land — leaked storage and an over-counted usage ledger, which
   * nothing else would ever report.
   */
  onTranscriptCleanupFailure?: (error: unknown) => void
}

/**
 * The record's `metadata.voiceCall`, written identically on both passes.
 *
 * `compacted` is what lets the card — and any later reader — tell a generated
 * record from a fallback one. They are different shapes of text: prose in the
 * assistant's voice versus a list of spoken turns, and the card renders each
 * as what it is.
 */
const callMetadata = (input: {
  compacted: boolean
  durationMs: number
  session: VoiceSession
  transcriptAttachmentId: string | null
  turnCount: number
}): Prisma.InputJsonValue => ({
  voiceCall: {
    voiceSessionId: input.session.id,
    durationMs: input.durationMs,
    turnCount: input.turnCount,
    transcriptAttachmentId: input.transcriptAttachmentId,
    compacted: input.compacted,
  },
})

/**
 * Writes the call record, once.
 *
 * The transcript slot is claimed in the same transaction that creates the
 * message, so a retried submission (or two tabs racing a hang-up) resolves to
 * exactly one record rather than two — and a call that has already ended can
 * still be recorded.
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
  // The claim is the transcript slot, not the status: a call that has already
  // ended must still be recordable, because a client that died mid-call
  // submits on its next launch and the duration cap (or a second tab) can end
  // a call out from under the client. Refusing those would discard exactly
  // the records that are hardest to reproduce.
  //
  // Creating the message and claiming the slot in ONE transaction is what
  // serializes two submissions: the second blocks on the row lock,
  // re-evaluates `transcriptMessageId: null` once the first commits, matches
  // nothing, and rolls its own message away with the transaction.
  const hasTranscript = input.lines.length > 0

  // Fail open, always. The compaction is a nicety on top of a record that must
  // exist: no model client, a provider error, an empty or unusable answer all
  // resolve to null here, and the verbatim summary is written instead. The
  // call is over and unreproducible — losing its record to a failed
  // summarisation would be the worst possible trade.
  const compaction = await compactCallTranscript({
    agentName: input.agentName,
    lines: input.lines,
    modelClient: input.modelClient,
    usage: attributionFromActorContext(input.actorContext, {
      agentId: input.session.agentId,
      agentKind: 'personal_assistant',
      systemComponent: 'voice-call-compaction',
    }),
    userDisplayName: input.userDisplayName,
    ...(input.onCompactionFailure ? { onFailure: input.onCompactionFailure } : {}),
  })
  const renderedContent = compaction
    ? renderCompactedCallSummary({
      compaction,
      durationMs: input.durationMs,
      turnCount: input.lines.length,
    })
    : renderCallSummary({
      durationMs: input.durationMs,
      lines: input.lines,
    })
  const content = redactDetectedSecrets(renderedContent)

  const attribution = attributionFromActorContext(input.actorContext, {
    agentId: input.session.agentId,
    agentKind: 'personal_assistant',
    systemComponent: 'voice-call',
  })

  // The bytes go down BEFORE the record exists, deliberately.
  //
  // Written the other way round — record first, transcript after — a storage
  // failure left a committed record holding the claim, so the client's retry
  // was refused as already-recorded and the transcript was gone for good. The
  // record that survived was indistinguishable from a call that never had one:
  // no control, no error, nothing to retry. That is the worst outcome
  // available, because a call cannot be reproduced.
  //
  // Storing first inverts which way a failure falls. Nothing is committed, the
  // slot stays unclaimed, and the same submission simply works when it is sent
  // again.
  const stored = hasTranscript
    ? await input.fileService.store({
      attribution,
      organizationId: input.session.organizationId,
      uploaderId: input.session.userId,
      filename: `voice-call-${input.session.startedAt.toISOString().slice(0, 19).replace(/[:T]/gu, '-')}.md`,
      mime: 'text/markdown',
      body: Readable.from([
        Buffer.from(
          renderTranscriptMarkdown({
            agentName: input.agentName,
            durationMs: input.durationMs,
            lines: input.lines,
            startedAt: input.session.startedAt,
            userDisplayName: input.userDisplayName,
          }),
          'utf8',
        ),
      ]),
      // Linked inside the transaction below, once the message it belongs to
      // exists. Until then it is an unlinked attachment, reachable only by its
      // own uploader — who is the caller.
    })
    : null
  const attachmentId = stored?.attachment.id ?? null

  let message: { id: string }
  try {
    message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          threadId: input.session.threadId,
          agentId: input.session.agentId,
          role: 'assistant',
          content,
          metadata: callMetadata({
            compacted: compaction !== null,
            durationMs: input.durationMs,
            session: input.session,
            transcriptAttachmentId: attachmentId,
            turnCount: input.lines.length,
          }),
        },
      })
      const claimed = await tx.voiceSession.updateMany({
        where: { id: input.session.id, transcriptMessageId: null },
        data: {
          transcriptMessageId: created.id,
          status: 'ended',
          endedAt: input.session.endedAt ?? new Date(),
        },
      })
      if (claimed.count !== 1) {
        throw new VoiceSessionError(
          'VOICE_TRANSCRIPT_ALREADY_RECORDED',
          'This call already has a record.',
          409,
        )
      }
      if (attachmentId) {
        await tx.attachment.update({
          data: { messageId: created.id },
          where: { id: attachmentId },
        })
      }
      return created
    })
  } catch (error) {
    // The record did not land, so its transcript must not linger. Freeing it
    // through the one `FileService` chokepoint is what keeps the storage
    // ledger honest: the bytes were counted at store, and only `delete` writes
    // the balancing event. A failure here leaks bytes and over-counts usage,
    // which is worth reporting but never worth masking the real error.
    if (attachmentId) {
      await input.fileService
        .delete(attachmentId, input.session.organizationId, attribution)
        .catch((cleanupError: unknown) => {
          input.onTranscriptCleanupFailure?.(cleanupError)
        })
    }
    throw error
  }

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
