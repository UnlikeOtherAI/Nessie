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
import { StatusPill } from '../../primitives/StatusPill'
import {
  formatRelativeTime,
  formatTimestamp,
  getInstallationTone,
  sectionTitle,
} from './presentation'

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
              <StatusPill tone={installations.length > 0 ? 'accent' : 'muted'}>
                {installations.length > 0 ? 'installed' : 'draft'}
              </StatusPill>
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
          </div>
        </div>
        {template.description ? (
          <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            {template.description}
          </p>
        ) : null}
      </div>

      <section>
        <div className={sectionTitle}>Steps</div>
        {steps.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
            No steps defined yet — open the designer to build this workflow.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {steps.map((step, index) => (
              <div className="flex items-center gap-3 px-3 py-2.5" key={step.id}>
                <span className="w-5 flex-shrink-0 text-right text-xs tabular-nums text-[color:var(--tx3)]">
                  {index + 1}
                </span>
                <FontAwesomeIcon
                  className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
                  icon={STEP_TYPE_ICONS[step.type] ?? faGear}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--tx)]">
                  {step.title ?? step.type}
                </span>
                <span className="flex-shrink-0 text-xs text-[color:var(--tx3)]">
                  {step.type}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <div className={sectionTitle}>Installations</div>
          <div className="text-xs text-[color:var(--tx3)]">
            {installations.length} total
          </div>
        </div>
        {installations.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
            Not installed yet. Install to attach triggers and start runs.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {installations.map((installation) => (
              <button
                className={[
                  'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left transition-colors',
                  installation.id === selectedInstallationId
                    ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-transparent hover:bg-[var(--overlay-weak)]',
                ].join(' ')}
                key={installation.id}
                onClick={() => onSelectInstallation(installation.id)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--tx)]">
                    Installation {installation.id.slice(0, 8)}
                  </div>
                  <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                    v{installation.workflowTemplateVersion} · updated{' '}
                    {formatRelativeTime(installation.updatedAt) ??
                      formatTimestamp(installation.updatedAt)}
                  </div>
                </div>
                <StatusPill tone={getInstallationTone(installation.status)}>
                  {installation.status}
                </StatusPill>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
