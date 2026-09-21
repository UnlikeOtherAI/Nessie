import { useState } from 'react'
import { useKnowledgePages, type KnowledgePageRecord, type KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import { knowledgeKeys } from '../../../facades/knowledge/keys'
import { usePagedList } from '../../../facades/pagination/usePagedList'
import { FormField } from '../../shared/FormField'
import { Select } from '../../shared/FormControls'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'

/** Documents remains the owner of source files and result folders. */
export const TaskSetDocumentPicker = ({
  label, mode, onSelect, selectedId, selectedSpaceId,
}: {
  label: string
  mode: 'file' | 'folder'
  onSelect: (selection: { spaceId: string; page?: KnowledgePageRecord }) => void
  selectedId?: string
  selectedSpaceId?: string
}) => {
  const [chosenSpaceId, setSpaceId] = useState<string>()
  const spaceId = chosenSpaceId ?? selectedSpaceId ?? ''
  const spaces = usePagedList<KnowledgeSpaceRecord>({
    path: '/api/knowledge-base/spaces', queryKey: knowledgeKeys.spaces,
    paramPrefix: `${mode}-spaces-`,
  })
  const pages = useKnowledgePages(spaceId || undefined)
  const options = (pages.data ?? []).filter((page) =>
    page.spaceId === spaceId && (mode === 'folder' ? page.kind === 'folder' : page.kind === 'file'),
  )
  return (
    <div className="grid gap-3">
      <QueryState errorLabel="Documents could not be loaded." loadingLabel="Loading Documents…" query={spaces.query}>
        {() => <>
          <FormField label={`${label} space`}>
            <Select onChange={(event) => {
              setSpaceId(event.target.value)
              if (mode === 'folder') onSelect({ spaceId: event.target.value })
            }} value={spaceId}>
              <option value="">Choose a Documents space</option>
              {spaces.items.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </Select>
          </FormField>
          <PaginationFooter {...spaces} hideWhenSinglePage />
        </>}
      </QueryState>
      {spaceId ? <QueryState errorLabel="Documents could not be loaded." loadingLabel="Loading documents…" query={pages}>
        {() => <FormField label={label}>
          <Select onChange={(event) => onSelect({
            spaceId, page: options.find((page) => page.id === event.target.value),
          })} value={selectedId ?? ''}>
            <option value="">{mode === 'folder' ? 'Space root' : 'Choose a file'}</option>
            {options.map((page) => <option key={page.id} value={page.id}>{page.title}</option>)}
          </Select>
        </FormField>}
      </QueryState> : null}
    </div>
  )
}
