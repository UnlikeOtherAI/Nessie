import type { FetchLike } from '@nessie/comms-google'
import { safeFetch } from '@nessie/runtime'

import type { GmailDraftDeps } from './gmail-drafts.js'

/** Keep the Gmail transport seam independent from credential/draft decisions. */
export const gmailFetch = (deps: GmailDraftDeps): FetchLike => {
  const impl = deps.fetchImpl ?? safeFetch
  return async (url, init) => {
    const response = await impl(url, init ?? {})
    return {
      body: response.body,
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
      text: () => response.text(),
    }
  }
}
