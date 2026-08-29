import type { AppDetailRecord } from '@nessie/schemas'
import { EmptyState } from '../../shared/EmptyState'
import { ToolCategoryIcon } from '../../shared/ToolCategoryIcon'
import { appCapabilityCount, capabilitiesNote } from './app-detail-view'

type AppCapabilityListProps = {
  app: AppDetailRecord
}

// What the app lets an agent do. Rendered before connecting as well as after,
// because "is this worth connecting?" is answered by this list — the note above
// it says which of those two a person is looking at.
export const AppCapabilityList = ({ app }: AppCapabilityListProps) => {
  const count = appCapabilityCount(app)
  const note = capabilitiesNote(app)

  return (
    <div className="grid gap-4" data-testid="app-capabilities">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {count !== null ? (
          <span className="text-sm text-[color:var(--tx2)]">
            {count} {count === 1 ? 'capability' : 'capabilities'}
          </span>
        ) : null}
        {note ? <span className="text-xs text-[color:var(--tx3)]">{note}</span> : null}
      </div>

      {app.capabilities.tools.length === 0 ? (
        <EmptyState>
          Nothing to list yet. Once this app is connected, everything it can do shows up here.
        </EmptyState>
      ) : (
        <ul className="grid gap-2">
          {app.capabilities.tools.map((tool) => (
            <li
              className={[
                'flex items-start gap-3 rounded-[var(--radius-md)]',
                'border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-4 py-3',
              ].join(' ')}
              key={tool.name}
            >
              <ToolCategoryIcon source="mcp-remote" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[color:var(--tx)]">
                  {tool.name}
                </div>
                {tool.description ? (
                  <p className="mt-0.5 text-xs leading-5 text-[color:var(--tx3)]">
                    {tool.description}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
