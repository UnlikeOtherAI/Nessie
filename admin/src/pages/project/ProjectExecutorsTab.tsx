import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ExecutorsTable } from '../../components/features/executors/ExecutorsTable'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useExecutors } from '../../facades/executors/hooks'

type ProjectExecutorsTabProps = {
  projectId: string
}

export const ProjectExecutorsTab = ({ projectId }: ProjectExecutorsTabProps) => {
  const { t } = useTranslation('projects')
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
            {t('executors.share')}
          </Link>
        }
        description={t('executors.description')}
        title={t('executors.title')}
      >
        <QueryState
          errorLabel={t('executors.loadError')}
          loadingLabel={t('executors.loading')}
          query={executorsQuery}
        >
          {() => <ExecutorsTable executors={executors} isLoading={false}
            emptyMessage={t('executors.empty')}
            onOpen={(id) => void navigate(`/agents/executors/${id}`)} />}
        </QueryState>
      </Section>
    </PageBody>
  )
}
