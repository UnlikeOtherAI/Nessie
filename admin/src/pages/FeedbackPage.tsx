import { useState } from 'react'
import { useFeedback } from '../facades/feedback/hooks'
import { FeedbackComposer } from './feedback/FeedbackComposer'
import { FeedbackList } from './feedback/FeedbackList'
import { SettingsPanel } from './settings/settings-shared'

export const FeedbackPage = () => {
  const feedback = useFeedback()
  const [page, setPage] = useState(1)

  return (
    <SettingsPanel eyebrow="General" title="Feedback">
      <div className="@container">
        <div
          className={[
            'grid gap-4',
            '@min-[900px]:grid-cols-[minmax(300px,0.85fr)_minmax(360px,1.15fr)]',
            '@min-[900px]:items-start',
          ].join(' ')}
        >
          <FeedbackComposer onSubmitted={() => setPage(1)} />
          <FeedbackList onPageChange={setPage} page={page} query={feedback} />
        </div>
      </div>
    </SettingsPanel>
  )
}
