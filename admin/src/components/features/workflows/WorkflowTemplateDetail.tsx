import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faBolt,
  faGear,
  faRobot,
  faScrewdriverWrench,
  faServer,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import type {
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { Row, RowList } from '../../shared/RowList'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import {
  formatRelativeTime,
  formatTimestamp,
  getInstallationTone,
} from './presentation'
import { downloadWorkflowExport } from './workflow-transfer'

/**
 * Template detail: what the workflow does (step chain), then where it runs
 * (installations, drill-down). "Install" is the primary action — it turns the
 * saved definition into something that can actually fire.
 */

type WorkflowTemplateDetailProps = {
  installations: WorkflowInstallationRecord[]
  isInstalling: boolean
  onInstall: () => void
  onEdit: () => void
  onSelectInstallation: (installationId: string) => void
  selectedInstallationId?: string
  template: WorkflowTemplateRecord
}

const STEP_TYPE_ICONS: Record<string, IconDefinition> = {
  agent: faRobot,
  agent_task: faRobot,
  environment_launch: faServer,
  tool: faScrewdriverWrench,
  tool_call: faScrewdriverWrench,
  trigger: faBolt,
}

export const WorkflowTemplateDetail = ({
  installations,
  isInstalling,
  onInstall,
  onEdit,
  onSelectInstallation,
  selectedInstallationId,
  template,
}: WorkflowTemplateDetailProps) => {
  const steps = template.graph.steps

  return (
    <div className="grid max-w-3xl gap-5">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                {template.name}
              </h2>
              <Pill tone={installations.length > 0 ? 'accent' : 'muted'}>
                {installations.length > 0 ? 'installed' : 'draft'}
              </Pill>
            </div>
            <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
              v{template.version} · {steps.length} step{steps.length === 1 ? '' : 's'} ·
              updated {formatRelativeTime(template.updatedAt) ?? formatTimestamp(template.updatedAt)}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              className="admin-button admin-button-primary"
              disabled={isInstalling}
              onClick={onInstall}
              type="button"
            >
              {isInstalling ? 'Installing…' : 'Install'}
            </button>
            <button
              className="admin-button admin-button-secondary"
              onClick={onEdit}
              type="button"
            >
              Open in designer
            </button>
            <button
              className="admin-button admin-button-secondary"
              onClick={() => downloadWorkflowExport(template)}
              type="button"
            >
              Export
            </button>
          </div>
        </div>
        {template.description ? (
          <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            {template.description}
          </p>
        ) : null}
      </div>

      <section>
        <SectionLabel>Steps</SectionLabel>
        {steps.length === 0 ? (
          <EmptyState className="mt-3">
            No steps defined yet — open the designer to build this workflow.
          </EmptyState>
        ) : (
          <RowList className="mt-3" label="Steps">
            {steps.map((step, index) => (
              <Row
                key={step.id}
                leading={
                  <span className="flex items-center gap-2">
                    <span className="w-5 text-right text-xs tabular-nums text-[color:var(--tx3)]">
                      {index + 1}
                    </span>
                    <FontAwesomeIcon
                      className="h-3.5 w-3.5 text-[color:var(--tx3)]"
                      icon={STEP_TYPE_ICONS[step.type] ?? faGear}
                    />
                  </span>
                }
                title={step.title ?? step.type}
                trailing={
                  <span className="text-xs text-[color:var(--tx3)]">{step.type}</span>
                }
              />
            ))}
          </RowList>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel>Installations</SectionLabel>
          <div className="text-xs text-[color:var(--tx3)]">
            {installations.length} total
          </div>
        </div>
        {installations.length === 0 ? (
          <EmptyState className="mt-3">
            Not installed yet. Install to attach triggers and start runs.
          </EmptyState>
        ) : (
          <RowList className="mt-3" label="Installations">
            {installations.map((installation) => (
              <Row
                key={installation.id}
                onClick={() => onSelectInstallation(installation.id)}
                selected={installation.id === selectedInstallationId}
                subtitle={
                  `v${installation.workflowTemplateVersion} · updated `
                  + `${formatRelativeTime(installation.updatedAt)
                    ?? formatTimestamp(installation.updatedAt)}`
                }
                title={`Installation ${installation.id.slice(0, 8)}`}
                trailing={
                  <Pill height="control" tone={getInstallationTone(installation.status)}>
                    {installation.status}
                  </Pill>
                }
              />
            ))}
          </RowList>
        )}
      </section>
    </div>
  )
}
