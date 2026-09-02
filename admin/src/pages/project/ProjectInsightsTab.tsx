import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { type ProjectInsights, useProjectInsights } from '../../facades/iterations/hooks'

const VelocityChart = ({ velocity }: { velocity: ProjectInsights['velocity'] }) => {
  if (velocity.length === 0) {
    return <div className="text-xs text-[color:var(--tx3)]">No completed sprints yet.</div>
  }
  const max = Math.max(1, ...velocity.map((point) => point.points))
  const barW = 44
  const gap = 20
  const height = 160
  const width = velocity.length * (barW + gap)
  return (
    <svg height={height + 28} role="img" viewBox={`0 0 ${Math.max(width, 1)} ${height + 28}`} width="100%">
      {velocity.map((point, index) => {
        const barHeight = (point.points / max) * height
        const x = index * (barW + gap) + gap / 2
        return (
          <g key={point.iterationId}>
            <rect
              fill="var(--accent)"
              height={barHeight}
              rx="3"
              width={barW}
              x={x}
              y={height - barHeight}
            />
            <text fill="var(--tx2)" fontSize="11" textAnchor="middle" x={x + barW / 2} y={height - barHeight - 4}>
              {point.points}
            </text>
            <text fill="var(--tx3)" fontSize="10" textAnchor="middle" x={x + barW / 2} y={height + 16}>
              {point.name.length > 8 ? `${point.name.slice(0, 8)}…` : point.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const BurndownChart = ({ burndown }: { burndown: NonNullable<ProjectInsights['burndown']> }) => {
  const { days, totalPoints } = burndown
  const total = Math.max(1, totalPoints)
  const width = 480
  const height = 180
  const padL = 28
  const padB = 20
  const stepX = (width - padL) / Math.max(1, days.length - 1)
  const xFor = (index: number) => padL + index * stepX
  const yFor = (value: number) => height - padB - (value / total) * (height - padB)
  const line = (selector: (day: (typeof days)[number]) => number) =>
    days.map((day, index) => `${xFor(index)},${yFor(selector(day))}`).join(' ')

  return (
    <svg height={height} role="img" viewBox={`0 0 ${width} ${height}`} width="100%">
      <line stroke="var(--sep)" x1={padL} x2={width} y1={height - padB} y2={height - padB} />
      <line stroke="var(--sep)" x1={padL} x2={padL} y1="0" y2={height - padB} />
      <text fill="var(--tx3)" fontSize="10" x="2" y="10">{total}</text>
      <text fill="var(--tx3)" fontSize="10" x="6" y={height - padB}>0</text>
      <polyline fill="none" points={line((day) => day.ideal)} stroke="var(--tx3)" strokeDasharray="4 3" strokeWidth="1.5" />
      <polyline fill="none" points={line((day) => day.remaining)} stroke="var(--accent)" strokeWidth="2" />
    </svg>
  )
}

type ProjectInsightsTabProps = {
  projectId: string
}

export const ProjectInsightsTab = ({ projectId }: ProjectInsightsTabProps) => {
  const insightsQuery = useProjectInsights(projectId)

  return (
    <PageBody width="regular">
      <QueryState
        errorLabel="Couldn't load insights."
        loadingLabel="Loading insights…"
        query={insightsQuery}
      >
        {() => {
          const insights = insightsQuery.data
          if (!insights) return null

          return (
            <>
              <Section
                description="Story points delivered per completed sprint."
                title="Velocity"
              >
                <div className="admin-card p-4">
                  <VelocityChart velocity={insights.velocity} />
                </div>
              </Section>

              <Section title="Burndown — active sprint">
                <div className="admin-card p-4">
                  {insights.burndown ? (
                    <>
                      <div className="mb-2 flex items-center gap-3 text-xs text-[color:var(--tx3)]">
                        <span className="font-semibold text-[color:var(--tx2)]">{insights.burndown.name}</span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-3 rounded-sm bg-[color:var(--accent)]" /> remaining
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-0 w-3 border-t border-dashed border-[color:var(--tx3)]" /> ideal
                        </span>
                      </div>
                      <BurndownChart burndown={insights.burndown} />
                    </>
                  ) : (
                    <div className="text-xs text-[color:var(--tx3)]">
                      Start a sprint with start and end dates to see its burndown.
                    </div>
                  )}
                </div>
              </Section>
            </>
          )
        }}
      </QueryState>
    </PageBody>
  )
}
