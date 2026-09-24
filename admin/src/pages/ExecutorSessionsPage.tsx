import { useNavigate } from 'react-router-dom'

import { ExecutorHostSessionList } from '../components/features/executors/ExecutorHostSessionList'
import { ScreenHeader } from '../components/shared/ScreenHeader'


export const ExecutorSessionsPage = () => {

  const navigate = useNavigate()
  return <div className="flex h-full min-h-0 flex-col">
    <ScreenHeader title="Sessions" eyebrow="Executors" backLabel="Back to executors"
      onBack={() => void navigate('/agents/executors')} subtitle="Your sessions and sessions shared with you" />
    <div className="overflow-y-auto px-[var(--page-gutter)] py-4">
      <ExecutorHostSessionList />
    </div>
  </div>
}
