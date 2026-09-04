import type { MailPresentToolInput } from '@nessie/schemas'

/**
 * The model-facing, content-free reference for the Mail surface.
 *
 * Mail tool results contain provider content for the model, but a person opens
 * that content through the live, entitlement-gated Mail API. Keeping the
 * pointer structurally separate means an agent can pass it unchanged to
 * `mail_present` rather than reconstructing a URL or guessing an account.
 */
export const reviewUrlForMailPresentation = (input: MailPresentToolInput): string => {
  const account = encodeURIComponent(input.accountId)
  const base = `/mail/${input.source}/${account}`
  if (input.mode === 'account') return base
  if (input.mode === 'thread' && input.threadId) {
    return `${base}/threads/${encodeURIComponent(input.threadId)}`
  }
  const query = new URLSearchParams()
  if (input.threadId) query.set('threadId', input.threadId)
  if (input.draftId) query.set('draftId', input.draftId)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return `${base}/compose${suffix}`
}

export type MailPresentationReference = MailPresentToolInput & {
  reviewUrl: string
}

export const mailPresentationReference = (
  input: MailPresentToolInput,
): MailPresentationReference => ({
  ...input,
  reviewUrl: reviewUrlForMailPresentation(input),
})

/** Add a machine-readable pointer without copying provider content into it. */
export const appendMailPresentationReferences = (
  output: string,
  references: readonly MailPresentationReference[],
): string => [
  output,
  JSON.stringify({ mailPresentation: references }),
].join('\n\n')
