import type {
  ReportVoiceUsageResponse,
  SubmitVoiceTranscriptResponse,
  VoiceDeviceToken,
  VoiceInstallationPlatform,
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
const NATIVE_INSTALLATION_STORAGE_KEY = 'nessie.voice.native-installation-id'

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
    const cached = readCachedInstallationId(INSTALLATION_STORAGE_KEY)
    if (cached) return cached
    const installation = await apiClient.post<VoiceInstallationRecord>(
      '/api/voice/installations',
      { platform: 'web', label: describeBrowser() },
    )
    writeCachedInstallationId(INSTALLATION_STORAGE_KEY, installation.id)
    return installation.id
  },

  /**
   * Registers a slot for the device the *native* layer will call from.
   *
   * Separate from the browser's own installation because Ledger reserves daily
   * budget per slot and the two are different devices as far as that budget is
   * concerned — the phone's app and the phone's browser can each hold a call.
   * Cached under its own key for the same reason.
   */
  ensureNativeInstallation: async (
    platform: VoiceInstallationPlatform,
    label: string,
  ): Promise<string> => {
    const cached = readCachedInstallationId(NATIVE_INSTALLATION_STORAGE_KEY)
    if (cached) return cached
    const installation = await apiClient.post<VoiceInstallationRecord>(
      '/api/voice/installations',
      { platform, label },
    )
    writeCachedInstallationId(NATIVE_INSTALLATION_STORAGE_KEY, installation.id)
    return installation.id
  },

  /**
   * Mints the voice-scoped credential the native layer holds during a call.
   *
   * Session auth, from the WebView, once: a credential that could mint its
   * successor would outlive the sign-out that should have ended it, so renewal
   * is the native side's own refresh exchange rather than another trip here.
   */
  mintDeviceToken: (installationId: string): Promise<VoiceDeviceToken> =>
    apiClient.post<VoiceDeviceToken>('/api/voice/device-token', { installationId }),

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

const readCachedInstallationId = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeCachedInstallationId = (key: string, id: string): void => {
  try {
    window.localStorage.setItem(key, id)
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
