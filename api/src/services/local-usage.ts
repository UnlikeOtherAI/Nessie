import { Prisma, type PrismaClient } from '@prisma/client'
import { budgetPeriodStart, type BudgetPeriod } from '@nessie/runtime'
import type {
  LocalUsageBy,
  LocalUsagePeriod,
  LocalUsageResponse,
  LocalUsageRow,
} from '@nessie/schemas'

/**
 * Admin › Usage and limits: what the organisation's teams, agents and people
 * used this week, month or year, from the local token ledger.
 *
 * Every row is named for a person to read — never a raw id — and the naming
 * keeps the visibility rules of what it names: another person's private agents
 * are folded into one nameless row, because an organisation owner never sees
 * another person's private agent (docs/standards/agent-ownership.md). This is
 * local operational data, estimated at the active prices; the billing
 * service's credits are a different page and never appear here.
 */

const PERIOD_OF: Record<LocalUsagePeriod, BudgetPeriod> = {
  month: 'monthly',
  week: 'weekly',
  year: 'yearly',
}

// A fixed map, never the caller's string: the column is spliced into SQL.
const GROUP_COLUMN: Record<LocalUsageBy, Prisma.Sql> = {
  agent: Prisma.raw('"agent_id"'),
  person: Prisma.raw('"user_id"'),
  team: Prisma.raw('"team_id"'),
}

type GroupRow = {
  key: string | null
  input_tokens: bigint | number | null
  output_tokens: bigint | number | null
  total_tokens: bigint | number | null
  estimated_cost: Prisma.Decimal | number | null
  unpriced_tokens: bigint | number | null
}

type Totals = Pick<LocalUsageRow, 'estimatedCost' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'unpricedTokens'>

const toNumber = (value: bigint | number | Prisma.Decimal | null): number =>
  value === null ? 0 : Number(value)

const totalsOf = (row: GroupRow): Totals => ({
  estimatedCost: toNumber(row.estimated_cost),
  inputTokens: toNumber(row.input_tokens),
  outputTokens: toNumber(row.output_tokens),
  totalTokens: toNumber(row.total_tokens),
  unpricedTokens: toNumber(row.unpriced_tokens),
})

const addTotals = (left: Totals, right: Totals): Totals => ({
  estimatedCost: left.estimatedCost + right.estimatedCost,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  totalTokens: left.totalTokens + right.totalTokens,
  unpricedTokens: left.unpricedTokens + right.unpricedTokens,
})

const ZERO: Totals = { estimatedCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unpricedTokens: 0 }

type Named = { name: string } | { privateAgent: true } | null

/** Names every id the page may show, by the rules of what it names. */
const resolveNames = async (
  prisma: PrismaClient,
  input: { by: LocalUsageBy; ids: string[]; organizationId: string; viewerUserId: string },
): Promise<Map<string, Named>> => {
  const names = new Map<string, Named>()
  if (input.ids.length === 0) return names
  if (input.by === 'team') {
    const teams = await prisma.team.findMany({
      where: { id: { in: input.ids }, project: { organizationId: input.organizationId } },
      select: { id: true, name: true },
    })
    for (const team of teams) names.set(team.id, { name: team.name })
    return names
  }
  if (input.by === 'person') {
    const people = await prisma.user.findMany({
      where: {
        id: { in: input.ids },
        organizationMembers: { some: { organizationId: input.organizationId } },
      },
      select: { displayName: true, email: true, id: true },
    })
    for (const person of people) names.set(person.id, { name: person.displayName || person.email })
    return names
  }
  const agents = await prisma.agent.findMany({
    where: { id: { in: input.ids }, organizationId: input.organizationId },
    select: { id: true, name: true, ownerUserId: true, visibility: true },
  })
  for (const agent of agents) {
    names.set(
      agent.id,
      agent.visibility === 'private' && agent.ownerUserId !== input.viewerUserId
        ? { privateAgent: true }
        : { name: agent.name },
    )
  }
  return names
}

export const getLocalUsage = async (
  prisma: PrismaClient,
  input: {
    by: LocalUsageBy
    now?: Date
    organizationId: string
    period: LocalUsagePeriod
    viewerUserId: string
  },
): Promise<LocalUsageResponse> => {
  const to = input.now ?? new Date()
  const from = budgetPeriodStart(PERIOD_OF[input.period], to)
  const column = GROUP_COLUMN[input.by]

  // Unpriced means the organisation paid for it through the model service and
  // no price is known. A personal plan or an own computer is never priced, by
  // design, so it is not "unpriced" and does not count here.
  const grouped = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
    SELECT
      ${column}::text AS key,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(estimated_cost_amount), 0) AS estimated_cost,
      COALESCE(SUM(CASE
        WHEN estimated_cost_amount IS NULL AND billing_source = 'ledger' THEN total_tokens
        ELSE 0
      END), 0) AS unpriced_tokens
    FROM token_ledger_events
    WHERE organization_id = ${input.organizationId}::uuid
      AND occurred_at >= ${from}
      AND occurred_at <= ${to}
    GROUP BY ${column}
    ORDER BY total_tokens DESC
  `)

  const ids = grouped.flatMap((row) => (row.key ? [row.key] : []))
  const names = await resolveNames(prisma, {
    by: input.by,
    ids,
    organizationId: input.organizationId,
    viewerUserId: input.viewerUserId,
  })

  const rows: LocalUsageRow[] = []
  let privateAgents = { count: 0, totals: ZERO }
  let unattributed = ZERO
  let removed = ZERO
  let totals = ZERO
  for (const row of grouped) {
    const rowTotals = totalsOf(row)
    totals = addTotals(totals, rowTotals)
    if (!row.key) {
      unattributed = addTotals(unattributed, rowTotals)
      continue
    }
    const named = names.get(row.key) ?? null
    if (named === null) {
      removed = addTotals(removed, rowTotals)
    } else if ('privateAgent' in named) {
      privateAgents = { count: privateAgents.count + 1, totals: addTotals(privateAgents.totals, rowTotals) }
    } else {
      rows.push({ count: null, id: row.key, kind: 'named', name: named.name, ...rowTotals })
    }
  }
  if (privateAgents.count > 0) {
    rows.push({ count: privateAgents.count, id: null, kind: 'private_agents', name: null, ...privateAgents.totals })
  }
  if (removed.totalTokens > 0 || removed.estimatedCost > 0) {
    rows.push({ count: null, id: null, kind: 'removed', name: null, ...removed })
  }
  if (unattributed.totalTokens > 0 || unattributed.estimatedCost > 0) {
    rows.push({ count: null, id: null, kind: 'unattributed', name: null, ...unattributed })
  }
  rows.sort((left, right) => right.totalTokens - left.totalTokens)

  return {
    by: input.by,
    currency: 'USD',
    estimatedCost: totals.estimatedCost,
    from: from.toISOString(),
    period: input.period,
    rows,
    to: to.toISOString(),
    totalTokens: totals.totalTokens,
    unpricedTokens: totals.unpricedTokens,
  }
}
