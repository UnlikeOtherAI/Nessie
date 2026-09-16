import { useRef, useState, type ChangeEvent } from 'react'
import {
  faFileLines,
  faPlus,
  faSpinner,
  faTable,
  faUpload,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate } from 'react-router-dom'
import { iconForFilename } from '../../../shared/file-icons'
import { Input } from '../../../shared/FormControls'
import { Pill } from '../../../primitives/Pill'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { taskDocumentStatusTone } from './task-status-presentation'
import {
  useCreateTaskPage,
  useTaskPages,
  useUploadTaskFile,
} from '../../../../facades/knowledge/task-docs-hooks'
import { useCreateSpreadsheet } from '../../../../facades/knowledge/spreadsheet-hooks'

// Compact "Documents" section shown inside the ticket dialog: the pages bound
// to this task (notes + uploaded files), an inline "New note" affordance, and
// an "Upload file" button. Project tasks enter the existing scoped Project
// Docs surface; a task without a project stays in the global Knowledge home.
// Only rendered once a task exists (edit mode).
export const TaskDocuments = ({
  projectId,
  taskId,
}: {
  projectId?: string | null
  taskId: string
}) => {
  const navigate = useNavigate()
  const pagesQuery = useTaskPages(taskId)
  const createPage = useCreateTaskPage(taskId)
  const uploadFile = useUploadTaskFile(taskId)

  // The ticket's own "New spreadsheet", beside "New note" — the same doorway
  // the space header carries, so a person never has to leave the ticket to make
  // one. The space is whichever one this task's documents already live in.
  const spaceId = pagesQuery.data?.[0]?.spaceId
  const createSpreadsheet = useCreateSpreadsheet(spaceId)

  const [addingNote, setAddingNote] = useState(false)
  const [addingKind, setAddingKind] = useState<'note' | 'spreadsheet'>('note')
  const [noteTitle, setNoteTitle] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pages = pagesQuery.data ?? []

  const openPage = (spaceId: string, pageId: string) => {
    const intent = new URLSearchParams({ pageId, spaceId })
    navigate(
      projectId
        ? `/projects/${projectId}/docs?${intent}`
        : `/knowledge-base?${intent}`,
    )
  }

  const submitNote = async () => {
    const trimmed = noteTitle.trim()
    if (!trimmed) {
      setAddingNote(false)
      return
    }
    const created = addingKind === 'spreadsheet' && spaceId
      ? await createSpreadsheet.mutateAsync({ taskId, title: trimmed })
      : await createPage.mutateAsync({ title: trimmed })
    setNoteTitle('')
    setAddingNote(false)
    openPage(created.spaceId, created.id)
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await uploadFile.mutateAsync({ file })
  }

  return (
    <div className="grid gap-2 rounded-md border border-[color:var(--sep)] p-3 md:col-span-2">
      <div className="flex items-center justify-between">
        <SectionLabel as="span" size="sm">Documents</SectionLabel>
        <div className="flex gap-2">
          <button
            className="admin-button admin-button-secondary admin-button-compact gap-1.5"
            disabled={uploadFile.isPending}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <FontAwesomeIcon
              icon={uploadFile.isPending ? faSpinner : faUpload}
              spin={uploadFile.isPending}
            />
            Upload file
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-compact gap-1.5"
            data-testid="task-new-spreadsheet"
            disabled={!spaceId}
            onClick={() => {
              setAddingKind('spreadsheet')
              setAddingNote(true)
            }}
            title={spaceId ? undefined : 'Add a document first, so this ticket has a space'}
            type="button"
          >
            <FontAwesomeIcon icon={faTable} />
            New spreadsheet
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-compact gap-1.5"
            onClick={() => {
              setAddingKind('note')
              setAddingNote(true)
            }}
            type="button"
          >
            <FontAwesomeIcon icon={faPlus} />
            New note
          </button>
        </div>
        <input
          accept="*"
          className="hidden"
          onChange={(event) => void handleFileChange(event)}
          ref={fileInputRef}
          type="file"
        />
      </div>

      {addingNote ? (
        <div className="flex gap-2">
          <Input
            aria-label={addingKind === 'spreadsheet' ? 'Spreadsheet title' : 'Note title'}
            autoFocus
            className="flex-1"
            onChange={(event) => setNoteTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitNote()
              } else if (event.key === 'Escape') {
                setAddingNote(false)
                setNoteTitle('')
              }
            }}
            placeholder={addingKind === 'spreadsheet' ? 'Spreadsheet title…' : 'Note title…'}
            value={noteTitle}
          />
          <button
            className="admin-button admin-button-primary admin-button-compact"
            disabled={!noteTitle.trim() || createPage.isPending || createSpreadsheet.isPending}
            onClick={() => void submitNote()}
            type="button"
          >
            Create
          </button>
        </div>
      ) : null}

      {pagesQuery.isLoading ? (
        <div className="py-2 text-sm text-[color:var(--tx3)]">Loading…</div>
      ) : pagesQuery.isError ? (
        <div className="py-2 text-sm text-[color:var(--danger-text)]">
          Couldn't load documents.{' '}
          <button className="underline" onClick={() => void pagesQuery.refetch()} type="button">
            Retry
          </button>
        </div>
      ) : pages.length === 0 ? (
        <div className="py-2 text-sm text-[color:var(--tx3)]">No documents yet</div>
      ) : (
        <div className="grid gap-0.5">
          {pages.map((page) => (
            <button
              className="flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)] hover:text-[color:var(--tx)]"
              key={page.id}
              onClick={() => openPage(page.spaceId, page.id)}
              type="button"
            >
              <FontAwesomeIcon
                className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
                fixedWidth
                icon={
                  page.kind === 'file'
                    ? iconForFilename(page.title)
                    : page.kind === 'spreadsheet'
                      ? faTable
                      : faFileLines
                }
              />
              <span className="min-w-0 flex-1 truncate">{page.title}</span>
              <Pill size="sm" tone={taskDocumentStatusTone(page.status)}>
                {page.status}
              </Pill>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
