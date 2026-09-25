import { Link, useNavigate } from 'react-router-dom'
import { ExecutorsTable } from '../../components/features/executors/ExecutorsTable'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useExecutors } from '../../facades/executors/hooks'

type ProjectExecutorsTabProps = {
  projectId: string
}

export const ProjectExecutorsTab = ({ projectId }: ProjectExecutorsTabProps) => {
  const executorsQuery = useExecutors(projectId)
  const navigate = useNavigate()
  const executors = executorsQuery.data ?? []

  return (
    <PageBody>
      <Section
        actions={
          <Link
            className="admin-button admin-button-primary"
            to="/agents/executors"
          >
            Share an executor
          </Link>
        }
        description="Executors shared with this project or its whole team. Open an executor to manage its agents and sharing."
        title="Project executors"
      >
        <QueryState
          errorLabel="Couldn't load project executors."
          loadingLabel="Loading executors…"
          query={executorsQuery}
        >
          {() => <ExecutorsTable executors={executors} isLoading={false}
            emptyMessage="No executor is shared with this project. Open an executor’s Permissions tab to share it."
            onOpen={(id) => void navigate(`/agents/executors/${id}`)} />}
        </QueryState>
      </Section>
    </PageBody>
  )
}
