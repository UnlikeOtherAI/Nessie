import { useTranslation } from 'react-i18next'
import { QueryState } from '../../../shared/QueryState'

export const FinderScopeReadState = ({
  query,
}: {
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
}) => {
  const { t } = useTranslation('knowledgeFinder')
  return <div className="min-w-0 flex-1">
    <QueryState
      className="py-6"
      errorLabel={t('couldNotLoadTheseDocuments')}
      loadingLabel={t('loadingDocuments')}
      query={query}
    >
      {() => null}
    </QueryState>
  </div>
}
