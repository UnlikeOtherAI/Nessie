import {
  type BoardSourceProvider,
  clearBoardSourceAdapters,
  listRegisteredProviders,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { createLinearAdapter } from '@nessie/board-source-linear'

/**
 * The one place board-source adapters enter the shared registry, called at API
 * and worker startup — the same seam `registerCommsConnectorsFromEnv` is for
 * the communications connectors.
 *
 * A provider with no credentials configured on this deployment stays
 * unregistered on purpose: the connect picker offers only what can actually
 * complete an OAuth round trip, and a job naming an unregistered provider parks
 * with a reason rather than failing in a way that reads like an outage.
 *
 * Each provider needs an app registered with the vendor once per deployment.
 * See docs/deployment.md → "Project board sources".
 */
export const registerBoardSourceAdaptersFromEnv = (
  env: NodeJS.ProcessEnv,
): BoardSourceProvider[] => {
  const linearClientId = env.NESSIE_BOARD_LINEAR_CLIENT_ID
  const linearClientSecret = env.NESSIE_BOARD_LINEAR_CLIENT_SECRET
  if (linearClientId && linearClientSecret) {
    registerBoardSourceAdapter('linear', () =>
      createLinearAdapter({
        clientId: linearClientId,
        clientSecret: linearClientSecret,
        ...(env.NESSIE_BOARD_LINEAR_WEBHOOK_SECRET
          ? { webhookSecret: env.NESSIE_BOARD_LINEAR_WEBHOOK_SECRET }
          : {}),
      }),
    )
  }

  return listRegisteredProviders()
}

export { clearBoardSourceAdapters }
