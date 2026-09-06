import {
  type BoardSourceProvider,
  clearBoardSourceAdapters,
  listRegisteredProviders,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { createGitHubAdapter } from '@nessie/board-source-github'
import { createJiraAdapter } from '@nessie/board-source-jira'
import { createLinearAdapter } from '@nessie/board-source-linear'
import { createTrelloAdapter } from '@nessie/board-source-trello'

/**
 * The one place board-source adapters enter the shared registry, called at API
 * and worker startup — the same seam `registerCommsConnectorsFromEnv` is for
 * the communications connectors.
 *
 * A provider stays unregistered when nothing on this deployment could complete
 * a connection for it — a job naming it then parks with a reason rather than
 * failing in a way that reads like an outage. That is now a narrower condition
 * than it was: a provider whose adapter offers a pasted API key needs no app
 * registered here at all, and registers regardless.
 *
 * See docs/deployment.md → "Project board sources".
 */
export const registerBoardSourceAdaptersFromEnv = (
  env: NodeJS.ProcessEnv,
): BoardSourceProvider[] => {
  // Linear registers unconditionally: its adapter always offers a personal API
  // key, which needs nothing configured here. The OAuth half appears only when
  // this deployment registered an app, and `listProviderMethods` reports which
  // of the two the picker may offer.
  const linearClientId = env.NESSIE_BOARD_LINEAR_CLIENT_ID
  const linearClientSecret = env.NESSIE_BOARD_LINEAR_CLIENT_SECRET
  registerBoardSourceAdapter('linear', () =>
    createLinearAdapter({
      ...(linearClientId ? { clientId: linearClientId } : {}),
      ...(linearClientSecret ? { clientSecret: linearClientSecret } : {}),
      ...(env.NESSIE_BOARD_LINEAR_WEBHOOK_SECRET
        ? { webhookSecret: env.NESSIE_BOARD_LINEAR_WEBHOOK_SECRET }
        : {}),
    }),
  )

  const jiraClientId = env.NESSIE_BOARD_JIRA_CLIENT_ID
  const jiraClientSecret = env.NESSIE_BOARD_JIRA_CLIENT_SECRET
  if (jiraClientId && jiraClientSecret) {
    registerBoardSourceAdapter('jira', () =>
      createJiraAdapter({ clientId: jiraClientId, clientSecret: jiraClientSecret }),
    )
  }

  const githubClientId = env.NESSIE_BOARD_GITHUB_CLIENT_ID
  const githubClientSecret = env.NESSIE_BOARD_GITHUB_CLIENT_SECRET
  if (githubClientId && githubClientSecret) {
    registerBoardSourceAdapter('github', () =>
      createGitHubAdapter({
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        ...(env.NESSIE_BOARD_GITHUB_WEBHOOK_SECRET
          ? { webhookSecret: env.NESSIE_BOARD_GITHUB_WEBHOOK_SECRET }
          : {}),
      }),
    )
  }

  // Trello's key and secret are a Power-Up's, not an OAuth client's — the
  // person's token arrives in a URL fragment rather than a code exchange.
  const trelloApiKey = env.NESSIE_BOARD_TRELLO_API_KEY
  const trelloApiSecret = env.NESSIE_BOARD_TRELLO_API_SECRET
  if (trelloApiKey && trelloApiSecret) {
    registerBoardSourceAdapter('trello', () =>
      createTrelloAdapter({ apiKey: trelloApiKey, apiSecret: trelloApiSecret }),
    )
  }

  return listRegisteredProviders()
}

export { clearBoardSourceAdapters }
