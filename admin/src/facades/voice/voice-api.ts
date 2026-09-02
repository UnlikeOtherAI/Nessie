import type {
  ReportVoiceUsageResponse,
  SubmitVoiceTranscriptResponse,
  VoiceInstallationRecord,
  VoiceSessionCredential,
  VoiceSessionRotation,
  VoiceTranscriptLine,
} from '@nessie/schemas'

import type { ApiClient, ThreadMessageRecord } from '../../lib/api-client'
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
   * Deliberately the same route the composer uses: the run it starts is
   * indistinguishable from one the person typed, so every existing gate —
   * approvals, policy, disclosure — applies without the voice path adding any
   * authority of its own.
   */
  sendToAssistant: (threadId: string, text: string): Promise<{ message: ThreadMessageRecord }> =>
    apiClient.post<{ message: ThreadMessageRecord }>(`/api/threads/${threadId}/messages`, {
      content: text,
    }),

  /**
   * Reads replies that landed after a given message.
   *
   * Polling rather than the thread SSE stream: a run that consumed a
   * privileged source has its live lane cut structurally, so the stream can
   * silently never deliver. A viewer-entitled read always answers correctly —
   * with the reply if the caller may see it, without it if not.
   */
  repliesAfter: async (
    threadId: string,
    afterMessageId: string,
  ): Promise<ThreadMessageRecord[]> => {
    const page = await apiClient.get<ThreadMessageRecord[]>(
      `/api/threads/${threadId}/messages?after=${encodeURIComponent(afterMessageId)}&limit=20`,
    )
    return page.filter((message) => message.role === 'assistant' && !message.deletedAt)
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
