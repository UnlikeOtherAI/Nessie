import { Notice } from '../../components/primitives/Notice'

export type SettingsFeedback = { kind: 'success' | 'error'; message: string }

/**
 * Inline success/error banner shared across settings pages. `role="alert"` so
 * the message is announced to assistive tech when it appears after an async
 * action.
 */
export const FeedbackBanner = ({ feedback }: { feedback: SettingsFeedback | null }) => {
  if (!feedback) {
    return null
  }

  return (
    <Notice role="alert" tone={feedback.kind === 'success' ? 'success' : 'danger'}>
      {feedback.message}
    </Notice>
  )
}
