import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AppDetailRecord } from '@nessie/schemas'
import { useProjects } from '../../../facades/projects/hooks'
import { Popover } from '../../overlays/Popover'

type AppBoardSourceActionProps = {
  setupSurface: AppDetailRecord['setupSurface']
}

/**
 * The second way into an app that is also a board source.
 *
 * One row in the store is one app: Linear or Jira is not two catalogue entries
 * because it can be reached two ways. This is the doorway from the app's page
 * to the project it should feed — the connect flow itself lives on that
 * project's Settings → Sources, because pointing a source at a project is
 * administering the project rather than installing the app.
 */
export const AppBoardSourceAction = ({ setupSurface }: AppBoardSourceActionProps) => {
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!setupSurface) return null

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={open}
        className="admin-button"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {setupSurface.label}
      </button>
      <Popover
        anchorRef={triggerRef}
        label={setupSurface.label}
        onClose={() => setOpen(false)}
        open={open}
        role="menu"
      >
        <div className="grid min-w-56 gap-1 p-1">
          {projects.length === 0 ? (
            <span className="px-2 py-1.5 text-sm text-[color:var(--tx3)]">
              No projects yet.
            </span>
          ) : (
            projects.map((project) => (
              <button
                className="rounded-md px-2 py-1.5 text-left text-sm text-[color:var(--tx)]
                  hover:bg-[color:var(--overlay)]"
                key={project.id}
                onClick={() => {
                  setOpen(false)
                  // `?connect=` is an intent the settings page consumes once, so
                  // the picker opens on arrival and the URL stops saying "open
                  // the picker" straight afterwards.
                  void navigate(
                    `/projects/${project.id}/settings?section=sources&connect=${setupSurface.provider}`,
                  )
                }}
                type="button"
              >
                {project.name}
              </button>
            ))
          )}
        </div>
      </Popover>
    </>
  )
}
