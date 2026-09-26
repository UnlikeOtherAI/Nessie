import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Section } from '../../../components/shared/PageBody'
import { Notice } from '../../../components/primitives/Notice'
import { useDeleteProject } from '../../../facades/projects/hooks'
import type { ProjectRecord } from '../../../lib/api-client'
import { projectDeleteRefusal, type DeleteBlock } from './project-settings-presentation'

type ProjectDeleteSectionProps = {
  canModify: boolean
  project: ProjectRecord
}

/**
 * The last section of Settings › General. It moved here from the Projects
 * sidebar's row menu, where a destructive action sat one slip away from
 * opening the project.
 *
 * Projects have no archive: `DELETE /api/projects/:id` is a soft delete that
 * keeps every row for a restore that does not exist yet, so the section offers
 * Delete alone and says exactly that rather than promising an Archive. Any
 * member of the project may delete it (docs/standards/team-model.md, rule 2);
 * when something still depends on it, every reason comes back at once and is
 * listed with the place that fixes it.
 */
export const ProjectDeleteSection = ({ canModify, project }: ProjectDeleteSectionProps) => {
  const navigate = useNavigate()
  const deleteProject = useDeleteProject()
  const [confirming, setConfirming] = useState(false)
  const [refusal, setRefusal] = useState<DeleteBlock[]>([])

  const runDelete = () => {
    setRefusal([])
    deleteProject.mutate(project.id, {
      onError: (cause) => {
        setConfirming(false)
        setRefusal(projectDeleteRefusal(project.id, cause))
      },
      // The project's own pages are gone; nothing here is left to go back to.
      onSuccess: () => void navigate('/projects', { replace: true }),
    })
  }

  return (
    <div className="border-t border-[color:var(--sep)] pt-6">
      <Section
        description="The project, its boards, tickets and channels disappear for everyone. They are kept rather than erased, but nothing here can bring them back yet."
        title="Delete this project"
      >
        {refusal.length > 0 ? (
          <Notice role="alert" size="sm" tone="danger">
            <span className="grid gap-1">
              <span>This project cannot be deleted yet:</span>
              {refusal.map((block) => (
                <span key={block.sentence}>
                  {block.sentence}
                  {block.doorway ? (
                    <>
                      {' '}
                      <Link className="underline" to={block.doorway.to}>{block.doorway.label}</Link>
                    </>
                  ) : null}
                </span>
              ))}
            </span>
          </Notice>
        ) : null}
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-danger"
            disabled={!canModify || deleteProject.isPending}
            onClick={() => setConfirming(true)}
            type="button"
          >
            Delete project
          </button>
        </div>
      </Section>
      <ConfirmDialog
        body="Its boards, tickets and channels go with it, for everyone in it."
        confirmLabel="Delete project"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={runDelete}
        open={confirming}
        pending={deleteProject.isPending}
        title={`Delete “${project.name}”?`}
      />
    </div>
  )
}
