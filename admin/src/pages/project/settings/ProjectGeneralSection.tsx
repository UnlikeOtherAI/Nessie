import { useEffect, useState, type FormEvent } from 'react'
import { ChoiceGroup } from '../../../components/shared/ChoiceGroup'
import { FormActions, FormError, FormSuccess } from '../../../components/shared/FormActions'
import { Input, Textarea } from '../../../components/shared/FormControls'
import { FormField } from '../../../components/shared/FormField'
import { Section } from '../../../components/shared/PageBody'
import { useUpdateProject } from '../../../facades/projects/hooks'
import type { ProjectRecord } from '../../../lib/api-client'
import { ProjectDeleteSection } from './ProjectDeleteSection'
import { ProjectPictureField, type ProjectPicture } from './ProjectPictureField'
import {
  PROJECT_VISIBILITY_COPY,
  projectChangeRefusal,
  type ProjectVisibility,
} from './project-settings-presentation'

type ProjectGeneralSectionProps = {
  canModify: boolean
  project: ProjectRecord
}

const VISIBILITIES: ProjectVisibility[] = ['public', 'protected']

/**
 * Settings › General: what the project is called, what it is for, its
 * picture, and who outside it may see it — the four facts the Edit project
 * dialog and nothing else used to hold, plus visibility, which the API always
 * accepted and no screen offered. Deleting the project closes the section.
 *
 * One Save for the form, and only what changed is sent. A person who may not
 * change the project sees every field, disabled; the page's own line says who
 * can (plan R9).
 */
export const ProjectGeneralSection = ({ canModify, project }: ProjectGeneralSectionProps) => {
  const updateProject = useUpdateProject()
  const savedVisibility: ProjectVisibility = project.visibility ?? 'public'
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [picture, setPicture] = useState<ProjectPicture>({
    avatarAttachmentId: project.avatarAttachmentId,
    avatarEmoji: project.avatarEmoji,
  })
  const [visibility, setVisibility] = useState<ProjectVisibility>(savedVisibility)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // "Saved." acknowledges and then clears itself, so it never reads as a
  // standing status line.
  useEffect(() => {
    if (!saved) return
    const id = window.setTimeout(() => setSaved(false), 2500)
    return () => window.clearTimeout(id)
  }, [saved])

  const trimmedName = name.trim()
  const trimmedDescription = description.trim()
  const changes = {
    ...(trimmedName !== project.name ? { name: trimmedName } : {}),
    ...(trimmedDescription !== (project.description ?? '')
      ? { description: trimmedDescription || null }
      : {}),
    ...(picture.avatarAttachmentId !== project.avatarAttachmentId
      || picture.avatarEmoji !== project.avatarEmoji
      ? picture
      : {}),
    ...(visibility !== savedVisibility ? { visibility } : {}),
  }
  const changed = Object.keys(changes).length > 0
  const busy = uploading || updateProject.isPending
  const disabled = !canModify || updateProject.isPending

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canModify || !trimmedName || !changed) return
    setError(null)
    try {
      await updateProject.mutateAsync({ projectId: project.id, ...changes })
      setSaved(true)
    } catch (cause) {
      setError(projectChangeRefusal(cause))
    }
  }

  return (
    <>
      <form className="grid gap-6" noValidate onSubmit={(event) => void submit(event)}>
        <Section title="General">
          <FormField label="Name" required>
            <Input
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => { setName(event.target.value); setError(null) }}
              value={name}
            />
          </FormField>
          <FormField
            help="Everybody in the organisation can read this, with the project's name and members."
            label="Description"
          >
            <Textarea
              disabled={disabled}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this project for?"
              rows={2}
              value={description}
            />
          </FormField>
        </Section>

        <Section
          description="Shown beside the project's name in the sidebar: an emoji or a photo."
          title="Picture"
        >
          <ProjectPictureField
            disabled={disabled}
            onBusyChange={setUploading}
            onChange={setPicture}
            picture={picture}
          />
        </Section>

        <Section title="Who can see it">
          <ChoiceGroup<ProjectVisibility>
            label="Visibility"
            labelHidden
            onChange={setVisibility}
            options={VISIBILITIES.map((value) => ({
              description: PROJECT_VISIBILITY_COPY[value].description,
              disabled: disabled,
              label: PROJECT_VISIBILITY_COPY[value].label,
              value,
            }))}
            value={visibility}
            variant="card"
          />
          {visibility !== savedVisibility ? (
            <p className="text-sm text-[color:var(--tx2)]" role="status">
              {PROJECT_VISIBILITY_COPY[visibility].consequence}
            </p>
          ) : null}
        </Section>

        <FormError>{error ?? undefined}</FormError>
        <FormSuccess>{saved ? 'Saved.' : undefined}</FormSuccess>
        <FormActions>
          <button
            className="admin-button admin-button-primary"
            disabled={!canModify || !trimmedName || !changed || busy}
            type="submit"
          >
            {updateProject.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </FormActions>
      </form>

      <ProjectDeleteSection canModify={canModify} project={project} />
    </>
  )
}
