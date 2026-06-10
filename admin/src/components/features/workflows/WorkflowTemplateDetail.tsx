import type {
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import {
  formatTimestamp,
  getInstallationTone,
  sectionTitle,
} from './presentation'

type WorkflowTemplateDetailProps = {
  installationCount: number
  latestInstallation?: WorkflowInstallationRecord
  isInstalling: boolean
  onInstall: () => void
  onEdit: () => void
  template: WorkflowTemplateRecord
}

export const WorkflowTemplateDetail = ({
  installationCount,
  isInstalling,
  latestInstallation,
  onInstall,
  onEdit,
  template,
}: WorkflowTemplateDetailProps) => {
  const stepCount = template.graph.steps.length
  const environmentCount = template.requiredEnvironmentTemplateIds.length

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-[var(--tx)]">
                {template.name}
              </h2>
              <StatusPill tone={latestInstallation ? 'accent' : 'muted'}>
                {latestInstallation ? 'installed' : 'saved'}
              </StatusPill>
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              Workflow template {template.id.slice(0, 8)} with {stepCount} step
              {stepCount === 1 ? '' : 's'}.
            </div>
          </div>

          <button
            className="admin-button admin-button-primary"
            onClick={onEdit}
            type="button"
          >
            Edit
          </button>
          <button
            className="admin-button"
            disabled={isInstalling}
            onClick={onInstall}
            type="button"
          >
            {isInstalling ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          ['Version', `${template.version}`],
          ['Updated', formatTimestamp(template.updatedAt)],
          ['Installations', `${installationCount}`],
          ['Environment templates', `${environmentCount}`],
        ].map(([label, value]) => (
          <div
            className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3"
            key={label}
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {label}
            </div>
            <div className="mt-2 text-sm text-[var(--tx)]">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className={sectionTitle}>Latest installation</div>
        {latestInstallation ? (
          <div className="mt-3 rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-[var(--tx)]">
                {latestInstallation.id.slice(0, 8)}
              </div>
              <StatusPill tone={getInstallationTone(latestInstallation.status)}>
                {latestInstallation.status}
              </StatusPill>
            </div>
            <div className="mt-2 text-sm text-[color:var(--tx2)]">
              Version {latestInstallation.workflowTemplateVersion}
              {latestInstallation.channelId
                ? ` · channel ${latestInstallation.channelId.slice(0, 8)}`
                : ' · not bound to a channel'}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx3)]">
              Updated {formatTimestamp(latestInstallation.updatedAt)}
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4 text-sm text-[color:var(--tx3)]">
            This workflow has not been installed yet.
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className={sectionTitle}>Workflow structure</div>
        <div className="mt-3 grid gap-2">
          {template.graph.steps.map((step, index) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2"
              key={step.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-[var(--tx)]">
                  {index + 1}. {step.title ?? step.type}
                </div>
                <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {step.type}
                </span>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">{step.id}</div>
            </div>
          ))}
          {template.graph.steps.length === 0 ? (
            <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4 text-center text-sm text-[color:var(--tx3)]">
              No steps defined yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
