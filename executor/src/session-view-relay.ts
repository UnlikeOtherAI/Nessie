import { ExecutorSessionViewOffersSchema, type ExecutorSessionViewRequest } from '@nessie/schemas'

import { executorApi } from './api-client.js'
import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** The caller owns serialization and cancellation, just like its command poll. */
export const createSessionViewRelay = (bridge: Pick<CodingSessionsDaemon, 'screen' | 'report'>) => {
  let requests: ExecutorSessionViewRequest[] = []
  let lastReport = 0
  return async (state: ExecutorLocalState): Promise<void> => {
    if (!state.connectionEpoch || !state.descriptor.codingSessions) return
    const frames = await Promise.all(requests.map(async (request) => ({
      ...request, screen: await bridge.screen(request).catch(() => null),
    })))
    const payload = {
      executorId: state.executorId, connectionEpoch: state.connectionEpoch,
      observedAt: new Date().toISOString(), frames,
      ...(Date.now() - lastReport > 15_000 ? { sessions: await bridge.report() } : {}),
    }
    if (payload.sessions) lastReport = Date.now()
    // Clear demand on failure; a reconnected daemon obtains fresh offers before uploading.
    requests = []
    const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'session_view', payload)
    const response = await executorApi.exchangeSessionViews(state.apiBaseUrl, { ...payload, signature })
    requests = ExecutorSessionViewOffersSchema.parse(response).requests
  }
}
