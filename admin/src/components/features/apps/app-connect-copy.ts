import type { AppSummaryRecord } from '@nessie/schemas'

/**
 * What the connect dialog can honestly say about an app before it probes.
 *
 * The rule this module exists for: **`authMethod` is only evidence on an entry
 * a human authored.** On a row ingested from the MCP Registry it is the column
 * default — the registry does not describe a server's auth — so 4,685 of the
 * catalogue's 5,532 rows read `none` and not one reads `oauth2`. Rendering that
 * as "This app needs no sign-in" turned a default into a promise and told
 * people that *Jira* needs no sign-in.
 *
 * Auth is discovered at connect time by the protocol itself (probe → 401 →
 * RFC 9728), so for an ingested row the dialog describes what is about to
 * happen and lets the probe answer. The probe's answer always wins once it
 * arrives, for authored rows too: a server can disagree with whatever the
 * catalogue recorded.
 */

/** Only a human-authored entry states its own auth; ingestion defaults it. */
export const catalogueStatesAuth = (app: AppSummaryRecord): boolean =>
  app.appSource !== 'mcp_registry'

/**
 * Who you are actually connecting to, or null when the entry names nobody.
 *
 * The catalogue's "Jira" is not Atlassian — it is `waystation.ai/jira/mcp`, a
 * third-party gateway that registered under that name, and the registry lets
 * any author pick any name. The card carries "By waystation" but the dialog did
 * not, so the one screen where a person decides to trust a server named a
 * famous company and nobody else. The name is the author's claim; the publisher
 * is what qualifies it — the same reason a trust badge is never minted from a
 * self-declared field.
 */
export const connectPublisherLine = (app: AppSummaryRecord): string | null => {
  if (!app.vendor) return null
  return app.trustLevel === 'community'
    ? `Published by ${app.vendor} · community-listed, not verified by Nessie`
    : `Published by ${app.vendor}`
}

/** The sentence shown before the probe answers. */
export const connectAuthExpectation = (app: AppSummaryRecord): string => {
  if (!catalogueStatesAuth(app)) {
    return `Nessie will ask ${app.vendor ?? app.displayName} what sign-in it needs.`
  }
  if (app.authMethod === 'oauth2') return `Connecting opens a ${app.displayName} sign-in window.`
  if (app.authMethod === 'none') return 'This app needs no sign-in.'
  return `${app.displayName} needs an API key.`
}
