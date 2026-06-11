import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

export const KnowledgeBasePage = () => (
  <div className="flex h-full flex-col">
    <MobileSectionHeader title="Knowledge" />
    <div className="min-h-0 flex-1">
      <KnowledgeWorkspace />
    </div>
  </div>
)
