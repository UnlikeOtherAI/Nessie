import type {
  ReportVoiceUsageResponse,
  SubmitVoiceTranscriptResponse,
  VoiceAssistantRepliesResponse,
  VoiceAssistantReply,
  VoiceInstallationRecord,
  VoiceSendToAssistantResponse,
  VoiceSessionCredential,
  VoiceSessionRotation,
  VoiceTranscriptLine,
} from '@nessie/schemas'

import type { ApiClient } from '../../lib/api-client'
import type { UsageReport } from './voice-usage-outbox'

/**
 * The Nessie half of a voice call: everything except the audio, which goes
 * straight to Google.
 *
 * Kept as one thin module so the call controller reads as lifecycle rather
 * than as URLs, and so the same surface can back a native client later.
 */

const INSTALLATION_STORAGE_KEY = 'nessie.voice.installation-id'

export type VoiceApi = ReturnType<typeof createVoiceApi>

export const createVoiceApi = (apiClient: ApiClient) => ({
  /**
   * Returns this browser's installation id, registering one on first use.
   *
   * The id is server-minted — a client-chosen identifier would let one account
   * multiply Ledger's per-device budget reservations. Only the opaque handle
   * is cached locally, and a stale one is re-registered rather than trusted.
   */
  ensureInstallation: async (): Promise<string> => {
    const cached = readCachedInstallationId()
    if (cached) return cached
    const installation = await apiClient.post<VoiceInstallationRecord>(
      '/api/voice/installations',
      { platform: 'web', label: describeBrowser() },
    )
    writeCachedInstallationId(installation.id)
    return installation.id
  },

  forgetInstallation: (): void => {
    try {
      window.localStorage.removeItem(INSTALLATION_STORAGE_KEY)
    } catch {
      // Nothing to forget if the store is unavailable.
    }
  },

  startSession: (installationId: string): Promise<VoiceSessionCredential> =>
    apiClient.post<VoiceSessionCredential>('/api/voice/sessions', { installationId }),

  rotateSession: (voiceSessionId: string): Promise<VoiceSessionRotation> =>
    apiClient.post<VoiceSessionRotation>(`/api/voice/sessions/${voiceSessionId}/rotate`),

  reportUsage: async (report: UsageReport): Promise<ReportVoiceUsageResponse> =>
    apiClient.post<ReportVoiceUsageResponse>(
      `/api/voice/sessions/${report.voiceSessionId}/usage`,
      {
        sequence: report.sequence,
        model: report.model,
        usage: report.usage,
        ...(report.complete ? { complete: true } : {}),
      },
    ),

  /** Runs one tool the model asked for; everything executes server-side. */
  runTool: (
    voiceSessionId: string,
    call: { providerCallId: string; name: string; args: Record<string, unknown> },
  ): Promise<{ result: Record<string, unknown>; replayed: boolean }> =>
    apiClient.post<{ result: Record<string, unknown>; replayed: boolean }>(
      `/api/voice/sessions/${voiceSessionId}/tool-call`,
      call,
    ),

  submitTranscript: (
    voiceSessionId: string,
    lines: VoiceTranscriptLine[],
    durationMs: number,
  ): Promise<SubmitVoiceTranscriptResponse> =>
    apiClient.post<SubmitVoiceTranscriptResponse>(
      `/api/voice/sessions/${voiceSessionId}/transcript`,
      { lines, durationMs },
    ),

  endSession: (voiceSessionId: string): Promise<void> =>
    apiClient.post(`/api/voice/sessions/${voiceSessionId}/end`),

  /**
   * Hands a request to the assistant as an ordinary typed message.
   *
   * The voice-scoped route rather than the generic composer one, so the
   * browser and a native call share a single code path. It writes the message
   * through the same service the composer's route uses, into the call's own
   * thread — which the caller never names — so the run it starts is
   * indistinguishable from a typed one and every existing gate applies
   * without the voice path adding any authority of its own.
   */
  sendToAssistant: (
    voiceSessionId: string,
    text: string,
    providerCallId: string,
  ): Promise<VoiceSendToAssistantResponse> =>
    apiClient.post<VoiceSendToAssistantResponse>(
      `/api/voice/sessions/${voiceSessionId}/pa-send`,
      { text },
      // Gemini retries a call it did not see answered; its own id is what
      // keeps one spoken request from becoming two runs.
      { 'Idempotency-Key': providerCallId },
    ),

  /**
   * Reads replies that landed after a given message.
   *
   * Polling rather than the thread SSE stream: a run that consumed a
   * privileged source has its live lane cut structurally, so the stream can
   * silently never deliver. A viewer-entitled read always answers correctly —
   * with the reply if the caller may see it, without it if not.
   */
  repliesAfter: async (
    voiceSessionId: string,
    afterMessageId: string,
  ): Promise<VoiceAssistantReply[]> => {
    const page = await apiClient.get<VoiceAssistantRepliesResponse>(
      `/api/voice/sessions/${voiceSessionId}/replies`
      + `?after=${encodeURIComponent(afterMessageId)}`,
    )
    return page.replies
  },
})

const readCachedInstallationId = (): string | null => {
  try {
    return window.localStorage.getItem(INSTALLATION_STORAGE_KEY)
  } catch {
    return null
  }
}

const writeCachedInstallationId = (id: string): void => {
  try {
    window.localStorage.setItem(INSTALLATION_STORAGE_KEY, id)
  } catch {
    // A private-mode browser re-registers next call; that is a wasted row,
    // not a failure, and the per-user cap still bounds it.
  }
}

/** A human label so a person can tell their devices apart when revoking one. */
const describeBrowser = (): string => {
  const agent = navigator.userAgent
  const browser = /Firefox\//u.test(agent)
    ? 'Firefox'
    : /Edg\//u.test(agent)
      ? 'Edge'
      : /Chrome\//u.test(agent)
        ? 'Chrome'
        : /Safari\//u.test(agent)
          ? 'Safari'
          : 'Browser'
  const platform = /Mac/u.test(agent)
    ? 'macOS'
    : /Windows/u.test(agent)
      ? 'Windows'
      : /Android/u.test(agent)
        ? 'Android'
        : /iPhone|iPad/u.test(agent)
          ? 'iOS'
          : 'web'
  return `${browser} on ${platform}`
}
