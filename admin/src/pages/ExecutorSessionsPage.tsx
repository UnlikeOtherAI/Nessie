import { useNavigate } from 'react-router-dom'

import { ExecutorHostSessionList } from '../components/features/executors/ExecutorHostSessionList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { COMPUTERS_PATH } from '../navigation/computers'


export const ExecutorSessionsPage = () => {

  const navigate = useNavigate()
  return <div className="flex h-full min-h-0 flex-col">
    <ScreenHeader title="Sessions" eyebrow="Computers" backLabel="Back to Computers"
      onBack={() => void navigate(COMPUTERS_PATH)} subtitle="Your sessions and sessions shared with you" />
    <div className="overflow-y-auto px-[var(--page-gutter)] py-4">
      <ExecutorHostSessionList />
    </div>
  </div>
}
