import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ExecutorsTable } from '../../../components/features/executors/ExecutorsTable'
import { Popover } from '../../../components/overlays/Popover'
import { Section } from '../../../components/shared/PageBody'
import { QueryState } from '../../../components/shared/QueryState'
import { useExecutors } from '../../../facades/executors/hooks'

/** A computer's Sharing tab, where a project is added to its audience. */
const sharingPath = (executorId: string): string => `/admin/computers/${executorId}?tab=sharing`

/**
 * "Share a computer" is a list of the machines the reader paired — the pairing
 * owner always administers a machine, so each of these is one they can share —
 * and each opens that computer's Sharing tab. A machine somebody else shared
 * with them as an administrator is reached through All computers.
 */
const ShareComputerMenu = () => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const executorsQuery = useExecutors()
  const mine = (executorsQuery.data ?? []).filter((executor) => executor.pairedByViewer === true)
  const close = () => setOpen(false)
  const itemClass = 'block rounded-md px-3 py-2 text-sm text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]'

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="admin-button admin-button-primary"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        Share a computer
      </button>
      <Popover
        anchorRef={triggerRef}
        className="w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-1 shadow-lg"
        label="Share a computer"
        onClose={close}
        open={open}
        placement="bottom-end"
        role="menu"
      >
        {mine.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">
            You have not paired a computer. Computers you pair appear here.
          </p>
        ) : (
          mine.map((executor) => (
            <Link className={itemClass} key={executor.id} onClick={close} role="menuitem" to={sharingPath(executor.id)}>
              {executor.label}
            </Link>
          ))
        )}
        <div className="my-1 border-t border-[color:var(--sep)]" role="separator" />
        <Link className={itemClass} onClick={close} role="menuitem" to="/admin/computers">
          All computers
        </Link>
      </Popover>
    </>
  )
}

/**
 * Settings › Computers: the machines shared with this project or with its
 * whole team. It was the project's Computers section — a read-only list whose
 * only action left the project — and is now a section of Settings, beside the
 * rest of what configures the project. Sharing itself stays on the computer
 * (docs/standards/executor-sharing.md), so the rows and the menu open it.
 */
export const ProjectComputersSection = ({ projectId }: { projectId: string }) => {
  const navigate = useNavigate()
  const executorsQuery = useExecutors(projectId)

  return (
    <Section
      actions={<ShareComputerMenu />}
      description="Computers shared with this project or its whole team. Agents working here can run on them."
      title="Computers"
    >
      <QueryState
        errorLabel="Couldn't load this project's computers."
        loadingLabel="Loading computers…"
        query={executorsQuery}
      >
        {() => (
          <ExecutorsTable
            emptyMessage="No computer is shared with this project yet. Share one of yours from its Sharing tab."
            executors={executorsQuery.data ?? []}
            isLoading={false}
            onOpen={(id) => void navigate(`/admin/computers/${id}`)}
          />
        )}
      </QueryState>
    </Section>
  )
}
