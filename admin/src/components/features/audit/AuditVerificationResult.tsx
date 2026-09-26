import { Link } from 'react-router-dom'
import type { UseQueryResult } from '@tanstack/react-query'

import type { AuditVerification } from '../../../facades/audit/hooks'
import { Notice } from '../../primitives/Notice'
import { auditEntryPath } from './AuditEventList'
import { auditVerificationSentence } from './audit-verification'

/**
 * What Verify integrity found, in words, under the header that ran it: a
 * success is announced politely, a break interrupts, and a break names the
 * entry the walk stopped at so a person can open it.
 */
export const AuditVerificationResult = ({
  verification,
}: {
  verification: UseQueryResult<AuditVerification>
}) => {
  if (verification.isFetching) {
    return (
      <Notice role="status" tone="neutral">
        Checking every entry against the one before it…
      </Notice>
    )
  }
  if (verification.isError) {
    return (
      <Notice role="alert" tone="danger">
        The trail couldn’t be checked just now. Try again in a moment.
      </Notice>
    )
  }
  if (!verification.data) return null

  const sentence = auditVerificationSentence(verification.data)
  return (
    <Notice
      data-testid="audit-verification"
      role={sentence.tone === 'danger' ? 'alert' : 'status'}
      tone={sentence.tone}
    >
      <p className="font-medium">{sentence.text}</p>
      {sentence.detail ? <p className="mt-1">{sentence.detail}</p> : null}
      {sentence.brokenEntryId ? (
        <Link className="mt-1 inline-block underline" to={auditEntryPath(sentence.brokenEntryId)}>
          Open that entry
        </Link>
      ) : null}
    </Notice>
  )
}
