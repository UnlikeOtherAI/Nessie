import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  UserIdSchema,
} from './ids.js'
import {
  ExecutorPlatformFactsSchema,
  ExecutorPlatformSchema,
  ExecutorSandboxBackendSchema,
  ExecutorSupervisorSchema,
} from './executor-platform.js'
import { CHAT_MESSAGE_MAX_CHARS } from './messaging.js'
import { createUuidBrandSchema, TimestampSchema } from './schema-primitives.js'

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
const ExecutorDaemonSignatureSchema = Base64UrlSchema.min(64).max(256)
// The daemon challenge is a compact signed token: two base64url segments with
// one literal separator. It is intentionally distinct from a single
// base64url field so the API can return and accept the value it issues.
const ExecutorDaemonChallengeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  .min(64)
  .max(2048)
const NonEmptyRecordSchema = z.record(z.string(), z.unknown())

export const ExecutorIdSchema = createUuidBrandSchema<'ExecutorId'>()
export type ExecutorId = z.infer<typeof ExecutorIdSchema>

export const ExecutorEnrollmentIdSchema =
  createUuidBrandSchema<'ExecutorEnrollmentId'>()
export type ExecutorEnrollmentId = z.infer<typeof ExecutorEnrollmentIdSchema>

export const ExecutorBindingIdSchema = createUuidBrandSchema<'ExecutorBindingId'>()
export type ExecutorBindingId = z.infer<typeof ExecutorBindingIdSchema>

export const ExecutorSessionIdSchema = createUuidBrandSchema<'ExecutorSessionId'>()
export type ExecutorSessionId = z.infer<typeof ExecutorSessionIdSchema>

export const ExecutorCommandIdSchema = createUuidBrandSchema<'ExecutorCommandId'>()
export type ExecutorCommandId = z.infer<typeof ExecutorCommandIdSchema>

export const ExecutorAccessChangeIdSchema =
  createUuidBrandSchema<'ExecutorAccessChangeId'>()
export type ExecutorAccessChangeId = z.infer<typeof ExecutorAccessChangeIdSchema>

export const ExecutorWorkspacePromotionIdSchema =
  createUuidBrandSchema<'ExecutorWorkspacePromotionId'>()
export type ExecutorWorkspacePromotionId = z.infer<typeof ExecutorWorkspacePromotionIdSchema>

export const ExecutorScopeKindSchema = z.enum([
  'private',
  'project',
  'organization',
])
export type ExecutorScopeKind = z.infer<typeof ExecutorScopeKindSchema>

export const ExecutorScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('private'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('project'),
      organizationId: OrganizationIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('organization'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
])
export type ExecutorScope = z.infer<typeof ExecutorScopeSchema>

export const ExecutorStatusSchema = z.enum([
  'pending_pairing',
  'online',
  'offline',
  'paused',
  'draining',
  'revoked',
  'error',
])
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>

export const ExecutorProfileSchema = z.enum([
  'workspace_sandbox',
  'coding_session',
  // A separately fenced session for a person-approved tab in their own Chrome.
  // It must never be mistaken for the fresh-profile VM browser.
  'connected_browser',
])
export type ExecutorProfile = z.infer<typeof ExecutorProfileSchema>

export const ExecutorOperationKeySchema = z.enum([
  'file.list',
  'file.read',
  'file.write',
  'command.run',
  'browser.open',
  'browser.observe',
  'browser.act',
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
  'workspace.review',
  'workspace.promote',
  'sandbox.stop',
  'coding.launch',
  'coding.attach',
  'coding.observe',
  'coding.prompt',
  'coding.interrupt',
  'coding.close',
])
export type ExecutorOperationKey = z.infer<typeof ExecutorOperationKeySchema>

/**
 * The sole catalog of executor operations with a live daemon implementation.
 * `workspace.promote` stays here because its daemon path is real, although it
 * remains intentionally absent from the model-facing toolset: only a person
 * can issue a reviewed promotion.
 */
export const IMPLEMENTED_EXECUTOR_OPERATION_KEYS = [
  'file.list',
  'file.read',
  'file.write',
  'command.run',
  'browser.open',
  'browser.observe',
  'browser.act',
  // The daemon has a local implementation, but the control plane must not
  // advertise this bundle until it can prove the originating run is private
  // and attach the owner-only disclosure basis for every observation.
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
  'coding.launch',
  'coding.observe',
  'workspace.review',
  'workspace.promote',
  'sandbox.stop',
] as const satisfies readonly ExecutorOperationKey[]
export type ImplementedExecutorOperationKey =
  (typeof IMPLEMENTED_EXECUTOR_OPERATION_KEYS)[number]
export const ImplementedExecutorOperationKeySchema = z.enum(
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS,
)

/** Arguments accepted by the first read-only workspace backend. */
export const ExecutorFileListArgumentsSchema = z
  .object({
    path: z.string().max(1_024).optional(),
    maxEntries: z.number().int().min(1).max(100).optional(),
  })
  .strict()
export type ExecutorFileListArguments = z.infer<typeof ExecutorFileListArgumentsSchema>

export const ExecutorFileReadArgumentsSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    // Eight KiB leaves room for JSON escaping inside the command's 64 KiB
    // terminal-result limit.
    maxBytes: z.number().int().min(1).max(8_192).optional(),
  })
  .strict()
export type ExecutorFileReadArguments = z.infer<typeof ExecutorFileReadArgumentsSchema>

/**
 * Writes are confined to the daemon-owned copy-on-write workspace. They can
 * never target the paired host root; promotion is a separate future operation.
 */
export const ExecutorFileWriteArgumentsSchema = z
  .object({
    content: z.string().max(65_536),
    createParents: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    path: z.string().min(1).max(1_024),
  })
  .strict()
export type ExecutorFileWriteArguments = z.infer<typeof ExecutorFileWriteArgumentsSchema>

/** Browser navigation is limited to one locally approved HTTPS URL. */
export const ExecutorBrowserOpenArgumentsSchema = z
  .object({
    url: z.string().url().max(4_096),
  })
  .strict()
export type ExecutorBrowserOpenArguments = z.infer<typeof ExecutorBrowserOpenArgumentsSchema>

/**
 * Browser observation exposes a bounded accessibility snapshot to every model.
 * A screenshot remains opt-in because only vision-capable providers can use it.
 */
export const ExecutorBrowserObserveArgumentsSchema = z
  .object({
    includeScreenshot: z.boolean().optional(),
  })
  .strict()
export type ExecutorBrowserObserveArguments = z.infer<typeof ExecutorBrowserObserveArgumentsSchema>

const ExecutorBrowserNodeIdSchema = z.number().int().min(0).max(2_147_483_647)
const ExecutorBrowserKeySchema = z.enum([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
])

/**
 * Closed CDP actions addressed only by a backend accessibility node id emitted
 * from `browser.observe`. Selectors, scripts, and pixel coordinates are never
 * accepted from the model.
 */
export const ExecutorBrowserActArgumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url().max(4_096) }).strict(),
  z.object({ action: z.literal('click'), nodeId: ExecutorBrowserNodeIdSchema }).strict(),
  z.object({ action: z.literal('type'), nodeId: ExecutorBrowserNodeIdSchema, text: z.string().max(4_096) }).strict(),
  z.object({ action: z.literal('press'), key: ExecutorBrowserKeySchema }).strict(),
  z.object({ action: z.literal('scroll'), nodeId: ExecutorBrowserNodeIdSchema.optional(), deltaY: z.number().int().min(-10_000).max(10_000).refine((value) => value !== 0) }).strict(),
])
export type ExecutorBrowserActArguments = z.infer<typeof ExecutorBrowserActArgumentsSchema>

/**
 * Connected Chrome accepts the same closed verb grammar as the isolated
 * browser. In particular it never accepts a tab id, selector, DevTools method,
 * script, profile name, or an extension-provided capability.
 */
export const ExecutorConnectedBrowserOpenArgumentsSchema = ExecutorBrowserOpenArgumentsSchema
export type ExecutorConnectedBrowserOpenArguments = z.infer<typeof ExecutorConnectedBrowserOpenArgumentsSchema>
export const ExecutorConnectedBrowserObserveArgumentsSchema = ExecutorBrowserObserveArgumentsSchema
export type ExecutorConnectedBrowserObserveArguments = z.infer<typeof ExecutorConnectedBrowserObserveArgumentsSchema>
export const ExecutorConnectedBrowserActArgumentsSchema = ExecutorBrowserActArgumentsSchema
export type ExecutorConnectedBrowserActArguments = z.infer<typeof ExecutorConnectedBrowserActArgumentsSchema>

const commandString = (maximum: number) => z.string().max(maximum).refine(
  (value) => !value.includes('\u0000'),
  'NUL bytes are not valid command arguments.',
)
const commandProgram = z.string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\u0000'), 'NUL bytes are not valid command arguments.')
  .refine((value) => !value.includes('/'), 'program must resolve through the fixed guest PATH.')
  .refine(
    (value) => !['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(value),
    'Shell interpreters are not available to executor commands.',
  )
const commandArgumentBytes = (value: { args: string[]; cwd?: string; program: string }): number => (
  new TextEncoder().encode([value.program, value.cwd ?? '', ...value.args].join('\u0000')).byteLength
)
const relativeWorkspacePath = (value: string): boolean => (
  value === '.' || (
    !value.startsWith('/')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
)

/** A shell-free argv command confined to the guest's COW workspace. */
export const ExecutorCommandRunArgumentsSchema = z
  .object({
    args: z.array(commandString(4_096)).max(64),
    cwd: commandString(1_024).refine(relativeWorkspacePath, 'cwd must stay within the workspace.').optional(),
    program: commandProgram,
  })
  .strict()
  .superRefine((value, context) => {
    if (commandArgumentBytes(value) > 24_576) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Command argv exceeds the executor control-frame budget.',
      })
    }
  })
export type ExecutorCommandRunArguments = z.infer<typeof ExecutorCommandRunArgumentsSchema>

/**
 * A coding task becomes a positional Codex prompt after a `--` option
 * delimiter. It is retained only in the encrypted executor command payload;
 * terminal output never returns to the control plane.
 */
export const ExecutorCodingLaunchArgumentsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_096),
  })
  .strict()
export type ExecutorCodingLaunchArguments = z.infer<typeof ExecutorCodingLaunchArgumentsSchema>

/** Coding lifecycle observation accepts no terminal selector or command. */
export const ExecutorCodingObserveArgumentsSchema = z.object({}).strict()
export type ExecutorCodingObserveArguments = z.infer<typeof ExecutorCodingObserveArgumentsSchema>

/**
 * Server-authored data for a human-confirmed COW promotion. This schema is
 * intentionally not included in the model-facing executor toolset: an agent
 * can prepare a draft and review it, but only a person can issue promotion.
 */
export const ExecutorWorkspacePromoteArgumentsSchema = z
  .object({
    approvalDigest: Sha256DigestSchema,
    manifestDigest: Sha256DigestSchema,
    promotionId: z.string().uuid(),
  })
  .strict()
export type ExecutorWorkspacePromoteArguments = z.infer<
  typeof ExecutorWorkspacePromoteArgumentsSchema
>

export const ExecutorPrivateAssignmentSchema = z.discriminatedUnion(
  'principalKind',
  [
    z
      .object({
        principalKind: z.literal('user'),
        userId: UserIdSchema,
        role: z.enum(['use', 'admin']),
      })
      .strict(),
    z
      .object({
        principalKind: z.literal('agent'),
        agentId: AgentIdSchema,
        role: z.literal('use'),
      })
      .strict(),
  ],
)
export type ExecutorPrivateAssignment = z.infer<
  typeof ExecutorPrivateAssignmentSchema
>

export const ExecutorAgentOperationGrantStateSchema = z.enum(['allowed', 'denied'])
export type ExecutorAgentOperationGrantState = z.infer<
  typeof ExecutorAgentOperationGrantStateSchema
>

export const ExecutorAgentOperationGrantSchema = z
  .object({
    executorId: ExecutorIdSchema,
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
    authorizationRevision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type ExecutorAgentOperationGrant = z.infer<
  typeof ExecutorAgentOperationGrantSchema
>

/**
 * Protocol version 1 still carries the widened host facts. `platform`,
 * `supervisor`, and `sandboxBackend` are required, so a pre-widening descriptor
 * cannot validate and a widened one cannot be mistaken for an older grammar:
 * required fields already discriminate the two, and there has only ever been
 * one producer train (the companion ships inside the desktop app or the
 * executor package, never independently). A second version number would give
 * no reader a decision it cannot already make. A stored descriptor from before
 * the change fails closed, which is the right answer for a machine whose
 * sandbox backend is unknown; its companion proposes a new revision.
 */
export const ExecutorCapabilityDescriptorSchema = z
  .object({
    protocolVersion: z.literal(1),
    revision: z.number().int().positive(),
    profiles: z.array(ExecutorProfileSchema).min(1).max(2),
    platform: ExecutorPlatformSchema,
    supervisor: ExecutorSupervisorSchema,
    sandboxBackend: ExecutorSandboxBackendSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(16),
    localPolicyDigest: Sha256DigestSchema,
    limits: z
      .object({
        maxCommandRuntimeSeconds: z.number().int().positive(),
        maxResultBytes: z.number().int().positive(),
        maxSessions: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
export type ExecutorCapabilityDescriptor = z.infer<
  typeof ExecutorCapabilityDescriptorSchema
>

export const ExecutorSignedDescriptorSchema = z
  .object({
    descriptor: ExecutorCapabilityDescriptorSchema,
    signature: Base64UrlSchema,
  })
  .strict()
export type ExecutorSignedDescriptor = z.infer<
  typeof ExecutorSignedDescriptorSchema
>

export const ExecutorEnrollmentRequestSchema = z
  .object({
    enrollmentId: ExecutorEnrollmentIdSchema,
    challenge: Base64UrlSchema.min(32),
    machinePublicKey: Base64UrlSchema.min(32),
    descriptor: ExecutorSignedDescriptorSchema,
    proof: Base64UrlSchema.min(32),
  })
  .strict()
export type ExecutorEnrollmentRequest = z.infer<
  typeof ExecutorEnrollmentRequestSchema
>

export const ExecutorDaemonClaimRequestSchema = z.object({
  challenge: ExecutorDaemonChallengeTokenSchema,
  executorId: ExecutorIdSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonClaimRequest = z.infer<typeof ExecutorDaemonClaimRequestSchema>

export const ExecutorDaemonHeartbeatRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonHeartbeatRequest = z.infer<typeof ExecutorDaemonHeartbeatRequestSchema>

/** A connected daemon may advertise a newer signed local-policy descriptor. */
export const ExecutorDaemonDescriptorRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  descriptor: ExecutorSignedDescriptorSchema,
  executorId: ExecutorIdSchema,
}).strict()
export type ExecutorDaemonDescriptorRequest = z.infer<typeof ExecutorDaemonDescriptorRequestSchema>

export const ExecutorDaemonCommandPollRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonCommandPollRequest = z.infer<
  typeof ExecutorDaemonCommandPollRequestSchema
>

export const ExecutorDaemonChallengeResponseSchema = z.object({
  challenge: ExecutorDaemonChallengeTokenSchema,
  expiresAt: TimestampSchema,
}).strict()
export type ExecutorDaemonChallengeResponse = z.infer<typeof ExecutorDaemonChallengeResponseSchema>

export const ExecutorDaemonConnectionResponseSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  status: ExecutorStatusSchema,
}).strict()
export type ExecutorDaemonConnectionResponse = z.infer<typeof ExecutorDaemonConnectionResponseSchema>

export const ExecutorDaemonDescriptorResponseSchema = z.object({
  reviewStatus: z.enum(['pending_review', 'active', 'disabled']),
  revision: z.number().int().positive(),
}).strict()
export type ExecutorDaemonDescriptorResponse = z.infer<
  typeof ExecutorDaemonDescriptorResponseSchema
>

export const ExecutorAvailabilityReasonSchema = z.enum([
  'ready',
  'executor_not_discoverable',
  'executor_offline',
  'scope_mismatch',
  'operation_ungranted',
  'logical_tool_ungranted',
  'descriptor_unreviewed',
  'local_policy_denied',
  'credential_unavailable',
])
export type ExecutorAvailabilityReason = z.infer<
  typeof ExecutorAvailabilityReasonSchema
>

export const ExecutorCandidateHandleSchema = z
  .string()
  .min(32)
  .max(512)
  .brand<'ExecutorCandidateHandle'>()
export type ExecutorCandidateHandle = z.infer<typeof ExecutorCandidateHandleSchema>

export const ExecutorAvailabilityRequestSchema = z
  .object({
    agentId: AgentIdSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(16),
    projectId: ProjectIdSchema.optional(),
    runId: RunIdSchema.optional(),
  })
  .strict()
export type ExecutorAvailabilityRequest = z.infer<
  typeof ExecutorAvailabilityRequestSchema
>

export const ExecutorAvailabilityCandidateSchema = z
  .object({
    handle: ExecutorCandidateHandleSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(16),
    readiness: z.literal('ready'),
    scopeKind: ExecutorScopeKindSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
export type ExecutorAvailabilityCandidate = z.infer<
  typeof ExecutorAvailabilityCandidateSchema
>

export const ExecutorAvailabilityExplanationSchema = z
  .object({
    readiness: z.literal('unavailable'),
    reason: ExecutorAvailabilityReasonSchema.exclude(['ready']),
  })
  .strict()
export type ExecutorAvailabilityExplanation = z.infer<
  typeof ExecutorAvailabilityExplanationSchema
>

export const ExecutorAvailabilityResponseSchema = z
  .object({
    candidates: z.array(ExecutorAvailabilityCandidateSchema).max(100),
    explanations: z.array(ExecutorAvailabilityExplanationSchema).max(16),
  })
  .strict()
export type ExecutorAvailabilityResponse = z.infer<
  typeof ExecutorAvailabilityResponseSchema
>

export const ExecutorRunBindRequestSchema = z.object({
  candidateHandle: ExecutorCandidateHandleSchema,
  operationKey: ImplementedExecutorOperationKeySchema,
}).strict()
export type ExecutorRunBindRequest = z.infer<typeof ExecutorRunBindRequestSchema>

export const ExecutorRunBindResponseSchema = z.object({
  bindingId: ExecutorBindingIdSchema,
  capabilityRevision: z.number().int().positive(),
  fence: z.string().regex(/^\d+$/),
  operationKey: ImplementedExecutorOperationKeySchema,
  runId: RunIdSchema,
}).strict()
export type ExecutorRunBindResponse = z.infer<typeof ExecutorRunBindResponseSchema>

/** A user-directed run whose executor selection is bound before queueing. */
export const ExecutorRunLaunchRequestSchema = z.object({
  agentId: AgentIdSchema,
  candidateHandle: ExecutorCandidateHandleSchema,
  content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  // Every operation in this bundle is independently re-authorized and bound
  // under the same opaque candidate. This lets draft work and its read-only
  // review stay on the same COW workspace without a model selecting a machine.
  operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(4).superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Operation keys must be unique.' })
    }
    const browserBundle: ImplementedExecutorOperationKey[] = [
      'browser.open',
      'browser.observe',
      'browser.act',
      'sandbox.stop',
    ]
    const browserRequested = value.includes('browser.open')
      || value.includes('browser.observe')
      || value.includes('browser.act')
    if (browserRequested && (
      value.length !== browserBundle.length
      || browserBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Browser runs are exactly browser.open, browser.observe, browser.act, and sandbox.stop.',
      })
    }
    const connectedBrowserBundle: ImplementedExecutorOperationKey[] = [
      'browser.connected.open',
      'browser.connected.observe',
      'browser.connected.act',
      'sandbox.stop',
    ]
    const connectedBrowserRequested = value.includes('browser.connected.open')
      || value.includes('browser.connected.observe')
      || value.includes('browser.connected.act')
    if (connectedBrowserRequested && (
      value.length !== connectedBrowserBundle.length
      || connectedBrowserBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Connected browser runs are exactly browser.connected.open, browser.connected.observe, browser.connected.act, and sandbox.stop.',
      })
    }
    const codingBundle: ImplementedExecutorOperationKey[] = [
      'coding.launch',
      'coding.observe',
      'workspace.review',
      'sandbox.stop',
    ]
    const codingRequested = value.includes('coding.launch') || value.includes('coding.observe')
    const commandBundle: ImplementedExecutorOperationKey[] = [
      'command.run',
      'workspace.review',
      'sandbox.stop',
    ]
    const commandRequested = value.includes('command.run')
    if (
      (browserRequested && (codingRequested || commandRequested || connectedBrowserRequested))
      || (connectedBrowserRequested && (codingRequested || commandRequested))
      || (codingRequested && commandRequested)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Isolated browser, connected browser, coding, and command operations cannot share one executor run.',
      })
    }
    if (codingRequested && (
      value.length !== codingBundle.length
      || codingBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Coding runs are exactly coding.launch, coding.observe, workspace.review, and sandbox.stop.',
      })
    }
    if (commandRequested && (
      value.length !== commandBundle.length
      || commandBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Command runs are exactly command.run, workspace.review, and sandbox.stop.',
      })
    }
  }),
}).strict()
export type ExecutorRunLaunchRequest = z.infer<typeof ExecutorRunLaunchRequestSchema>

export const ExecutorRunLaunchResponseSchema = z.object({
  bindings: z.array(ExecutorRunBindResponseSchema).min(1).max(4),
  messageId: z.string().uuid(),
  runId: RunIdSchema,
  taskId: TaskIdSchema,
}).strict()
export type ExecutorRunLaunchResponse = z.infer<typeof ExecutorRunLaunchResponseSchema>

export const ExecutorCommandReceiptStateSchema = z.enum([
  'accepted',
  'started',
  'result_acknowledged',
  'unknown_outcome',
])
export type ExecutorCommandReceiptState = z.infer<
  typeof ExecutorCommandReceiptStateSchema
>

export const ExecutorCommandEnvelopeSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    bindingId: ExecutorBindingIdSchema,
    bindingFence: z.string().regex(/^\d+$/),
    capabilityRevision: z.number().int().positive(),
    operationKey: ImplementedExecutorOperationKeySchema,
    expiresAt: TimestampSchema,
    idempotencyKey: z.string().min(1).max(255),
    argumentDigest: Sha256DigestSchema,
    payload: NonEmptyRecordSchema,
  })
  .strict()
export type ExecutorCommandEnvelope = z.infer<typeof ExecutorCommandEnvelopeSchema>

export const ExecutorCommandReceiptSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    // `unknown_outcome` is server-owned recovery state, never a daemon claim.
    state: z.enum(['accepted', 'started', 'result_acknowledged']),
    resultDigest: Sha256DigestSchema.optional(),
    occurredAt: TimestampSchema,
  })
  .strict()
export type ExecutorCommandReceipt = z.infer<typeof ExecutorCommandReceiptSchema>

export const ExecutorDaemonCommandPollResponseSchema = z.object({
  command: ExecutorCommandEnvelopeSchema.nullable(),
}).strict()
export type ExecutorDaemonCommandPollResponse = z.infer<
  typeof ExecutorDaemonCommandPollResponseSchema
>

export const ExecutorDaemonCommandReceiptRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  receipt: ExecutorCommandReceiptSchema,
  result: NonEmptyRecordSchema.optional(),
  signature: ExecutorDaemonSignatureSchema,
}).strict().superRefine((value, context) => {
  if (value.receipt.state === 'result_acknowledged' && !value.result) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A result acknowledgement requires a structured result.',
      path: ['result'],
    })
  }
  if (value.receipt.state !== 'result_acknowledged' && value.result !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only a result acknowledgement may carry a result.',
      path: ['result'],
    })
  }
})
export type ExecutorDaemonCommandReceiptRequest = z.infer<
  typeof ExecutorDaemonCommandReceiptRequestSchema
>

export const ExecutorLifecycleActionSchema = z.enum(['pause', 'resume', 'drain', 'revoke'])
export type ExecutorLifecycleAction = z.infer<typeof ExecutorLifecycleActionSchema>

export const ExecutorPrivateAssignmentPrincipalSchema = z.discriminatedUnion(
  'principalKind',
  [
    z.object({ principalKind: z.literal('user'), userId: UserIdSchema }).strict(),
    z.object({ principalKind: z.literal('agent'), agentId: AgentIdSchema }).strict(),
  ],
)
export type ExecutorPrivateAssignmentPrincipal = z.infer<
  typeof ExecutorPrivateAssignmentPrincipalSchema
>

export const ExecutorAccessChangeRequestSchema = z.union([
  z.object({
    kind: z.literal('private_assignment'),
    action: z.literal('set'),
    assignment: ExecutorPrivateAssignmentSchema,
  }).strict(),
  z.object({
    kind: z.literal('private_assignment'),
    action: z.literal('remove'),
    principal: ExecutorPrivateAssignmentPrincipalSchema,
  }).strict(),
  z.object({
    kind: z.literal('agent_operation_grant'),
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
  }).strict(),
  z.object({
    kind: z.literal('lifecycle'),
    action: ExecutorLifecycleActionSchema,
  }).strict(),
  z.object({
    kind: z.literal('descriptor_review'),
    revision: z.number().int().positive(),
    status: z.enum(['active', 'disabled']),
  }).strict(),
])
export type ExecutorAccessChangeRequest = z.infer<
  typeof ExecutorAccessChangeRequestSchema
>

export const ExecutorAccessChangeConfirmationSchema = z
  .object({
    accessChangeId: ExecutorAccessChangeIdSchema,
    confirmationToken: Base64UrlSchema.min(32),
    verificationChallengeId: z.string().uuid().optional(),
  })
  .strict()
export type ExecutorAccessChangeConfirmation = z.infer<
  typeof ExecutorAccessChangeConfirmationSchema
>

export const ExecutorRecordResponseSchema = z.object({
  id: ExecutorIdSchema,
  scope: ExecutorScopeSchema,
  label: z.string().min(1),
  profiles: z.array(ExecutorProfileSchema),
  // Absent until the paired daemon submits its first descriptor. Read-only:
  // the host states these facts under its own signature and no API caller can
  // write them.
  platformFacts: ExecutorPlatformFactsSchema.optional(),
  machineKeyFingerprint: z.string().optional(),
  status: ExecutorStatusSchema,
  authorizationRevision: z.number().int().positive(),
  lastSeenAt: TimestampSchema.optional(),
  statusDetail: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutorRecordResponse = z.infer<typeof ExecutorRecordResponseSchema>

export const ExecutorPairingInvitationResponseSchema = z.object({
  enrollmentId: ExecutorEnrollmentIdSchema,
  challenge: z.string().min(32),
  expiresAt: TimestampSchema,
})
export type ExecutorPairingInvitationResponse = z.infer<
  typeof ExecutorPairingInvitationResponseSchema
>

export const ExecutorCreateResponseSchema = z.object({
  executor: ExecutorRecordResponseSchema,
  invitation: ExecutorPairingInvitationResponseSchema,
})
export type ExecutorCreateResponse = z.infer<typeof ExecutorCreateResponseSchema>

export const PendingExecutorEnrollmentResponseSchema = z.object({
  executorId: ExecutorIdSchema,
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  descriptorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: TimestampSchema,
})
export type PendingExecutorEnrollmentResponse = z.infer<
  typeof PendingExecutorEnrollmentResponseSchema
>

export const ExecutorPrivateAssignmentResponseSchema = z.discriminatedUnion(
  'principalKind',
  [
    z.object({
      principalKind: z.literal('user'),
      role: z.enum(['use', 'admin']),
      userId: UserIdSchema,
    }).strict(),
    z.object({
      agentId: AgentIdSchema,
      principalKind: z.literal('agent'),
      role: z.literal('use'),
    }).strict(),
  ],
)
export type ExecutorPrivateAssignmentResponse = z.infer<
  typeof ExecutorPrivateAssignmentResponseSchema
>

/** A reviewed, signed local policy proposal. The raw signature remains server-only. */
export const ExecutorDescriptorReviewResponseSchema = z.object({
  localPolicyDigest: Sha256DigestSchema,
  operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(100),
  profiles: z.array(ExecutorProfileSchema).min(1).max(10),
  reviewStatus: z.enum(['pending_review', 'active', 'disabled']),
  revision: z.number().int().positive(),
}).strict()
export type ExecutorDescriptorReviewResponse = z.infer<
  typeof ExecutorDescriptorReviewResponseSchema
>

export const ExecutorSessionStatusSchema = z.enum([
  'pending',
  'active',
  'attention',
  'detached',
  'stopped',
  'failed',
])
export type ExecutorSessionStatus = z.infer<typeof ExecutorSessionStatusSchema>

export const ExecutorSessionSummaryResponseSchema = z.object({
  createdAt: TimestampSchema,
  id: ExecutorSessionIdSchema,
  originChannelId: ChannelIdSchema.optional(),
  profile: ExecutorProfileSchema,
  runId: RunIdSchema.optional(),
  status: ExecutorSessionStatusSchema,
  updatedAt: TimestampSchema,
}).strict()
export type ExecutorSessionSummaryResponse = z.infer<typeof ExecutorSessionSummaryResponseSchema>

export const ExecutorAccessViewResponseSchema = z.object({
  canManage: z.boolean(),
  executorId: ExecutorIdSchema,
  effectiveAccess: z.object({
    organizationRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullable(),
    privateAssignment: z.enum(['none', 'use', 'admin']),
    projectRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullable(),
  }).strict(),
  descriptorRevisions: z.array(ExecutorDescriptorReviewResponseSchema).max(20).optional(),
  operationGrants: z.array(z.object({
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
    updatedAt: TimestampSchema,
  }).strict()).optional(),
  privateAssignments: z.array(ExecutorPrivateAssignmentResponseSchema).optional(),
  sessions: z.array(ExecutorSessionSummaryResponseSchema).max(20).optional(),
})
export type ExecutorAccessViewResponse = z.infer<
  typeof ExecutorAccessViewResponseSchema
>

/** A content-free, human-reviewable COW change summary. */
export const ExecutorWorkspaceReviewChangeSchema = z.object({
  byteCount: z.number().int().nonnegative(),
  kind: z.enum(['created', 'modified', 'deleted']),
  path: z.string().min(1).max(1_024),
}).strict()
export type ExecutorWorkspaceReviewChange = z.infer<typeof ExecutorWorkspaceReviewChangeSchema>

export const ExecutorWorkspaceReviewRecordResponseSchema = z.object({
  acknowledgedAt: TimestampSchema,
  changes: z.array(ExecutorWorkspaceReviewChangeSchema).max(100),
  commandId: ExecutorCommandIdSchema,
  manifestDigest: Sha256DigestSchema,
  runId: RunIdSchema,
}).strict()
export type ExecutorWorkspaceReviewRecordResponse = z.infer<
  typeof ExecutorWorkspaceReviewRecordResponseSchema
>

/** A review may be promoted only by the user whose run produced it. */
export const OriginatingExecutorWorkspaceReviewRecordResponseSchema =
  ExecutorWorkspaceReviewRecordResponseSchema.extend({
    executorId: ExecutorIdSchema,
  }).strict()
export type OriginatingExecutorWorkspaceReviewRecordResponse = z.infer<
  typeof OriginatingExecutorWorkspaceReviewRecordResponseSchema
>

export const ExecutorWorkspacePromotionPrepareRequestSchema = z.object({
  reviewCommandId: ExecutorCommandIdSchema,
}).strict()
export type ExecutorWorkspacePromotionPrepareRequest = z.infer<
  typeof ExecutorWorkspacePromotionPrepareRequestSchema
>

export const PreparedExecutorWorkspacePromotionResponseSchema = z.object({
  changeCount: z.number().int().nonnegative().max(100),
  confirmationToken: Base64UrlSchema.min(32),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  manifestDigest: Sha256DigestSchema,
  promotionId: ExecutorWorkspacePromotionIdSchema,
  runId: RunIdSchema,
}).strict()
export type PreparedExecutorWorkspacePromotionResponse = z.infer<
  typeof PreparedExecutorWorkspacePromotionResponseSchema
>

export const ExecutorWorkspacePromotionRecordResponseSchema = z.object({
  changeCount: z.number().int().nonnegative().max(100),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  manifestDigest: Sha256DigestSchema,
  promotionId: ExecutorWorkspacePromotionIdSchema,
  requiresFreshVerification: z.literal(true),
  runId: RunIdSchema,
  status: z.enum(['pending', 'confirmed', 'consumed', 'rejected', 'expired']),
}).strict()
export type ExecutorWorkspacePromotionRecordResponse = z.infer<
  typeof ExecutorWorkspacePromotionRecordResponseSchema
>

export const ExecutorAccessChangeResponseSchema = z.object({
  accessChangeId: ExecutorAccessChangeIdSchema,
  executorId: ExecutorIdSchema,
  change: z.record(z.string(), z.unknown()),
  expiresAt: TimestampSchema,
  requiresFreshVerification: z.boolean(),
  status: z.enum(['pending', 'confirmed', 'rejected', 'expired', 'consumed']),
})
export type ExecutorAccessChangeResponse = z.infer<
  typeof ExecutorAccessChangeResponseSchema
>

export const PreparedExecutorAccessChangeResponseSchema = z.object({
  accessChangeId: ExecutorAccessChangeIdSchema,
  confirmationToken: Base64UrlSchema.min(32),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  requiresFreshVerification: z.boolean(),
})
export type PreparedExecutorAccessChangeResponse = z.infer<
  typeof PreparedExecutorAccessChangeResponseSchema
>
