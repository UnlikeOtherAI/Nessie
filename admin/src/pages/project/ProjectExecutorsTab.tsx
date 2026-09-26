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
            to="/admin/computers"
          >
            Share a computer
          </Link>
        }
        description="Computers shared with this project or its whole team. Open a computer to manage its agents and sharing."
        title="Computers"
      >
        <QueryState
          errorLabel="Couldn't load project computers."
          loadingLabel="Loading computers…"
          query={executorsQuery}
        >
          {() => <ExecutorsTable executors={executors} isLoading={false}
            emptyMessage="No computer is shared with this project. Open a computer’s Permissions tab to share it."
            onOpen={(id) => void navigate(`/admin/computers/${id}`)} />}
        </QueryState>
      </Section>
    </PageBody>
  )
}
