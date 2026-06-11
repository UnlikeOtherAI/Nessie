import { useFeedback } from '../facades/feedback/hooks'
import { FeedbackComposer } from './feedback/FeedbackComposer'
import { FeedbackList } from './feedback/FeedbackList'
import { SettingsPanel } from './settings/settings-shared'

export const FeedbackPage = () => {
  const { data: feedback = [], isLoading } = useFeedback()

  return (
    <SettingsPanel eyebrow="General" title="Feedback">
      <div className="flex flex-col gap-4">
        <FeedbackComposer />
        <FeedbackList isLoading={isLoading} items={feedback} />
      </div>
    </SettingsPanel>
  )
}
