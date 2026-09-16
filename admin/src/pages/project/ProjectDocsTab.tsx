import { KnowledgeProvider } from '../../components/features/knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../../components/features/knowledge/KnowledgeWorkspace'
import { useKnowledgePageDeepLink } from '../../components/features/knowledge/useKnowledgePageDeepLink'
import { useClearProjectAttention } from '../../facades/alerts/clear-project-attention'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'

/**
 * The project's own documents: the same Finder the Knowledge section renders,
 * scoped by `KnowledgeProvider` to this project and starting *inside* the
 * project's Documents folder.
 *
 * The 208px navy space rail is gone. It was a second picker in front of the
 * one the redesign removes, and the spaces it listed are now rows at the top
 * of column 0 — one click away, which is what the rail cost two.
 */
const ProjectDocsLayout = ({ projectId }: { projectId: string }) => {
  const { spacesLoaded } = useKnowledge()
  useClearProjectAttention(projectId, 'knowledge_published', spacesLoaded)

  // `?spaceId=&pageId=` — how the dashboard's Documents rows land on a document.
  useKnowledgePageDeepLink()

  return <KnowledgeWorkspace scope={{ kind: 'project', projectId }} />
}

export const ProjectDocsTab = ({ projectId }: { projectId: string }) => (
  <KnowledgeProvider projectId={projectId}>
    <ProjectDocsLayout projectId={projectId} />
  </KnowledgeProvider>
)
