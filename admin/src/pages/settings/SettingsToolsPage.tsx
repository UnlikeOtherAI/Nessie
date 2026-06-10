import { useTools } from '../../facades/tools/hooks'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsToolsPage = () => {
  const { data: tools = [] } = useTools()

  return (
    <SettingsPanel eyebrow="Workspace" title="Tools">
      <section className="admin-card p-4">
        <div className={sectionTitleClass}>Available tools</div>
        <div className="mt-4 grid gap-2">
          {tools.map((tool) => (
            <div key={tool.id} id={`tool-${tool.id}`} className="admin-card p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-[color:var(--tx)]">{tool.label}</div>
                <span
                  className={[
                    'rounded bg-[color:var(--overlay-weak)] px-1.5 py-0.5 text-[10px]',
                    'uppercase tracking-[0.16em] text-[color:var(--tx3)]',
                  ].join(' ')}
                >
                  {tool.safe ? 'safe' : 'restricted'}
                </span>
              </div>
              <div className="mt-2 text-sm text-[color:var(--tx2)]">{tool.description}</div>
            </div>
          ))}
        </div>
      </section>
    </SettingsPanel>
  )
}
