import { QueryState } from '../../../shared/QueryState'

export const FinderScopeReadState = ({
  query,
}: {
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
}) => (
  <div className="min-w-0 flex-1">
    <QueryState
      className="py-6"
      errorLabel="Couldn’t load these documents."
      loadingLabel="Loading documents…"
      query={query}
    >
      {() => null}
    </QueryState>
  </div>
)
