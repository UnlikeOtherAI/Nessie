import { z } from 'zod'

/**
 * Contracts for calling the Personal Assistant with live voice.
 *
 * The server brokers a one-use Gemini Live credential from Ledger and hands
 * the client everything it needs to open the socket itself: audio flows
 * device↔Google, and the deployment's `LEDGER_PROXY_TOKEN` never leaves the
 * server. Spec: `docs/plans/2026-09-02-gemini-voice-calling.md`.
 */

export const VoiceInstallationPlatformSchema = z.enum(['web', 'ios', 'android'])
export type VoiceInstallationPlatform = z.infer<typeof VoiceInstallationPlatformSchema>

/**
 * Body for `POST /api/voice/installations` — registers this browser or app.
 *
 * Deliberately carries no client-chosen identifier: Ledger reserves budget per
 * device slot, so a client that could name its own device could mint unlimited
 * slots. The id in the response is server-minted, and per-user caps are
 * enforced against it.
 */
export const RegisterVoiceInstallationRequestSchema = z
  .object({
    platform: VoiceInstallationPlatformSchema,
    label: z.string().min(1).max(120).optional(),
  })
  .strict()
export type RegisterVoiceInstallationRequest = z.infer<
  typeof RegisterVoiceInstallationRequestSchema
>

export const VoiceInstallationRecordSchema = z.object({
  id: z.string().uuid(),
  platform: VoiceInstallationPlatformSchema,
  label: z.string().min(1).optional(),
  lastSeenAt: z.string().min(1),
  createdAt: z.string().min(1),
})
export type VoiceInstallationRecord = z.infer<typeof VoiceInstallationRecordSchema>

/** Body for `POST /api/voice/sessions` — starts one call. */
export const StartVoiceSessionRequestSchema = z
  .object({
    installationId: z.string().uuid(),
  })
  .strict()
export type StartVoiceSessionRequest = z.infer<typeof StartVoiceSessionRequestSchema>

/**
 * One seeded conversation turn.
 *
 * `model` is Gemini's name for the assistant role. Seeded history is sent as
 * role-bearing turns rather than folded into the system instruction, so
 * nothing anyone typed in the DM is promoted to instruction authority.
 */
export const VoiceSeedTurnSchema = z.object({
  role: z.enum(['user', 'model']),
  text: z.string().min(1),
})
export type VoiceSeedTurn = z.infer<typeof VoiceSeedTurnSchema>

/** Server-enforced ceilings for one call. */
export const VoiceSessionLimitsSchema = z.object({
  maxDurationMs: z.number().int().positive(),
  maxToolCalls: z.number().int().nonnegative(),
})
export type VoiceSessionLimits = z.infer<typeof VoiceSessionLimitsSchema>

/**
 * Everything a client needs to open and run one call.
 *
 * `accessToken` is Google's one-use ephemeral credential (an `auth_tokens/…`
 * name), valid for a single new session started within seconds and expiring
 * within the half hour. It is the only credential a client ever holds.
 */
export const VoiceSessionCredentialSchema = z.object({
  voiceSessionId: z.string().uuid(),
  accessToken: z.string().min(1),
  websocketUrl: z.string().url(),
  model: z.string().min(1),
  /** When the credential dies; the client rotates before this. */
  expiresAt: z.string().min(1),
  /** The socket must be opened before this — Ledger allows ~45 seconds. */
  newSessionExpiresAt: z.string().min(1),
  voiceName: z.string().min(1),
  systemInstruction: z.string().min(1),
  seedTurns: z.array(VoiceSeedTurnSchema),
  functionDeclarations: z.array(z.record(z.string(), z.unknown())),
  limits: VoiceSessionLimitsSchema,
  channelId: z.string().uuid(),
  threadId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string().min(1),
})
export type VoiceSessionCredential = z.infer<typeof VoiceSessionCredentialSchema>

/**
 * Credential-only payload for `POST /api/voice/sessions/:id/rotate`.
 *
 * Rotation replaces the Google credential for the *same* call: the voice
 * session id, its seeded context, and its transcript slot all survive. A
 * rotation that minted a new voice session would split the usage relay and
 * double the transcript.
 */
export const VoiceSessionRotationSchema = VoiceSessionCredentialSchema.pick({
  accessToken: true,
  expiresAt: true,
  model: true,
  newSessionExpiresAt: true,
  voiceSessionId: true,
  websocketUrl: true,
})
export type VoiceSessionRotation = z.infer<typeof VoiceSessionRotationSchema>

/** Per-modality token counts, exactly as Gemini reports them. */
const ModalityCountsSchema = z.record(z.string(), z.number().int().nonnegative())

/**
 * One turn's usage, relayed verbatim to Ledger.
 *
 * Gemini re-bills the accumulated context on every turn, so each report is a
 * cumulative snapshot rather than a delta — the field names mirror Google's
 * `usageMetadata` so nothing is reinterpreted on the way through.
 */
export const VoiceUsageSnapshotSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  cachedPromptTokens: z.number().int().nonnegative(),
  responseTokens: z.number().int().nonnegative(),
  toolUsePromptTokens: z.number().int().nonnegative(),
  thoughtTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inputModalities: ModalityCountsSchema,
  cachedModalities: ModalityCountsSchema,
  outputModalities: ModalityCountsSchema,
  toolUsePromptModalities: ModalityCountsSchema,
})
export type VoiceUsageSnapshot = z.infer<typeof VoiceUsageSnapshotSchema>

/** Body for `POST /api/voice/sessions/:id/usage`. */
export const ReportVoiceUsageRequestSchema = z
  .object({
    sequence: z.number().int().positive(),
    model: z.string().min(1),
    usage: VoiceUsageSnapshotSchema.nullable(),
    complete: z.boolean().optional(),
  })
  .strict()
export type ReportVoiceUsageRequest = z.infer<typeof ReportVoiceUsageRequestSchema>

export const ReportVoiceUsageResponseSchema = z.object({
  acceptedSequence: z.number().int().nonnegative(),
  duplicate: z.boolean(),
  complete: z.boolean(),
})
export type ReportVoiceUsageResponse = z.infer<typeof ReportVoiceUsageResponseSchema>

/** One spoken line, as the client heard it. */
export const VoiceTranscriptLineSchema = z.object({
  speaker: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(4_000),
  /** Milliseconds since the call started. */
  atMs: z.number().int().nonnegative(),
})
export type VoiceTranscriptLine = z.infer<typeof VoiceTranscriptLineSchema>

/**
 * Body for `POST /api/voice/sessions/:id/transcript` — ends the call and
 * writes its one durable record.
 *
 * The lines are client-reported (only the client heard the audio), which is
 * why the record renders as a client transcript and the server cross-checks it
 * against the usage turns it actually relayed for this session.
 */
export const SubmitVoiceTranscriptRequestSchema = z
  .object({
    lines: z.array(VoiceTranscriptLineSchema).max(2_000),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
export type SubmitVoiceTranscriptRequest = z.infer<typeof SubmitVoiceTranscriptRequestSchema>

export const SubmitVoiceTranscriptResponseSchema = z.object({
  messageId: z.string().uuid().nullable(),
})
export type SubmitVoiceTranscriptResponse = z.infer<typeof SubmitVoiceTranscriptResponseSchema>

/**
 * The `metadata.voiceCall` key stamped on a call-record message.
 *
 * Server-authored: a client never posts this. The admin keys its collapsed
 * call card on it, the way other metadata-rendered messages work.
 */
export const VoiceCallMessageMetadataSchema = z.object({
  voiceSessionId: z.string().uuid(),
  durationMs: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  /** Attachment holding the full transcript, when there was one to store. */
  transcriptAttachmentId: z.string().uuid().nullable(),
})
export type VoiceCallMessageMetadata = z.infer<typeof VoiceCallMessageMetadataSchema>

/** Body for `POST /api/voice/sessions/:id/pa-send`. */
export const VoiceSendToAssistantRequestSchema = z
  .object({
    text: z.string().min(1).max(4_000),
  })
  .strict()
export type VoiceSendToAssistantRequest = z.infer<typeof VoiceSendToAssistantRequestSchema>

export const VoiceSendToAssistantResponseSchema = z.object({
  messageId: z.string().uuid(),
  rootMessageId: z.string().uuid(),
})
export type VoiceSendToAssistantResponse = z.infer<typeof VoiceSendToAssistantResponseSchema>

/** A reply the assistant produced after a `pa_send`, polled by the client. */
export const VoiceAssistantReplySchema = z.object({
  messageId: z.string().uuid(),
  text: z.string(),
  createdAt: z.string().min(1),
})
export type VoiceAssistantReply = z.infer<typeof VoiceAssistantReplySchema>

export const VoiceAssistantRepliesResponseSchema = z.object({
  replies: z.array(VoiceAssistantReplySchema),
})
export type VoiceAssistantRepliesResponse = z.infer<typeof VoiceAssistantRepliesResponseSchema>
