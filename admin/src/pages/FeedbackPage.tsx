import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFeedback } from '../facades/feedback/hooks'
import { FeedbackComposer } from './feedback/FeedbackComposer'
import { FeedbackList } from './feedback/FeedbackList'
import { SettingsPanel } from '../components/shared/SettingsPanel'

export const FeedbackPage = () => {
  const { t } = useTranslation('feedback')
  const feedback = useFeedback()
  const [page, setPage] = useState(1)

  return (
    <SettingsPanel eyebrow={t('general')} title={t('title')}>
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
