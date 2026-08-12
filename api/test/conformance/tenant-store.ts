import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * Faithful in-memory Prisma stand-in for tenant-isolation conformance tests.
 *
 * The whole point of this suite is to prove that a caller from organisation B
 * cannot read or mutate organisation A's rows. That guarantee is only meaningful
 * if the fake datastore applies the *exact* `where` clause each route/service
 * hands it — nothing more, nothing less. If a handler forgets to scope a query
 * by `organizationId`, this store returns the foreign-org row, and the
 * conformance assertion turns red (a real leak). Conversely, when scoping is
 * correct the foreign-org row is filtered out and the caller gets 403/404/empty.
 *
 * Design notes:
 *  - A `Proxy` lazily materialises a per-model row array for any model the code
 *    under test touches, so an unstubbed model never throws a 500 — it simply
 *    behaves as an empty table (the conservative "denied" answer).
 *  - The matcher honours scalar equality, `in`/`notIn`/`not`/comparison
 *    operators, and nested `AND`/`OR`/`NOT`. To-one relation filters (`is` /
 *    `isNot`) are resolved through the conventional `<relation>Id` foreign key.
 *  - Relations are NOT hydrated into `select`/`include` results. Every scoping
 *    gate exercised here rejects on a scalar `organizationId` (or `id`) check
 *    that runs before any relation payload is inspected, so leaving relations
 *    unresolved cannot flip a denial into an allow.
 */

type Row = Record<string, unknown>

const RELATION_OPERATORS = new Set(['is', 'isNot', 'some', 'none', 'every'])
const SCALAR_OPERATORS = new Set([
  'equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains',
])

const isPlainObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const scalarEquals = (rowValue: unknown, condition: unknown): boolean => {
  if (rowValue instanceof Date && condition instanceof Date) {
    return rowValue.getTime() === condition.getTime()
  }
  return rowValue === condition
}

const matchOperators = (rowValue: unknown, condition: Row): boolean => {
  for (const [op, expected] of Object.entries(condition)) {
    switch (op) {
      case 'equals':
        if (!scalarEquals(rowValue, expected)) return false
        break
      case 'not':
        if (isPlainObject(expected)) {
          if (matchOperators(rowValue, expected)) return false
        } else if (scalarEquals(rowValue, expected)) {
          return false
        }
        break
      case 'in':
        if (!Array.isArray(expected) || !expected.some((v) => scalarEquals(rowValue, v))) return false
        break
      case 'notIn':
        if (Array.isArray(expected) && expected.some((v) => scalarEquals(rowValue, v))) return false
        break
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const a = rowValue instanceof Date ? rowValue.getTime() : (rowValue as number)
        const b = expected instanceof Date ? expected.getTime() : (expected as number)
        if (rowValue === null || rowValue === undefined) return false
        if (op === 'lt' && !(a < b)) return false
        if (op === 'lte' && !(a <= b)) return false
        if (op === 'gt' && !(a > b)) return false
        if (op === 'gte' && !(a >= b)) return false
        break
      }
      case 'contains':
        if (typeof rowValue !== 'string' || !rowValue.includes(String(expected))) return false
        break
      default:
        // Unknown operator: fail closed towards "does not match" only when we
        // truly cannot interpret it. In practice the scoping gates never rely on
        // exotic operators, so this branch is defensive.
        return false
    }
  }
  return true
}

export class TenantStore {
  private readonly tables = new Map<string, Row[]>()

  private table(model: string): Row[] {
    let rows = this.tables.get(model)
    if (!rows) {
      rows = []
      this.tables.set(model, rows)
    }
    return rows
  }

  /** Seed rows for a model. Returns the live backing array for later assertions. */
  seed(model: string, rows: Row[]): Row[] {
    const table = this.table(model)
    table.push(...rows.map((r) => ({ ...r })))
    return table
  }

  /** Live view of a model's rows — use to assert a mutation left them untouched. */
  rows(model: string): Row[] {
    return this.table(model)
  }

  private matchWhere(model: string, row: Row, where: unknown): boolean {
    if (!isPlainObject(where)) return true
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue
      if (key === 'AND') {
        const clauses = Array.isArray(condition) ? condition : [condition]
        if (!clauses.every((clause) => this.matchWhere(model, row, clause))) return false
        continue
      }
      if (key === 'OR') {
        const clauses = Array.isArray(condition) ? condition : [condition]
        if (clauses.length > 0 && !clauses.some((clause) => this.matchWhere(model, row, clause))) {
          return false
        }
        continue
      }
      if (key === 'NOT') {
        const clauses = Array.isArray(condition) ? condition : [condition]
        if (clauses.some((clause) => this.matchWhere(model, row, clause))) return false
        continue
      }
      if (isPlainObject(condition)) {
        const conditionKeys = Object.keys(condition)
        const hasRelationOperator = conditionKeys.some((k) => RELATION_OPERATORS.has(k))
        const allScalarOperators = conditionKeys.every((k) => SCALAR_OPERATORS.has(k))
        if (hasRelationOperator) {
          if (!this.matchRelation(model, row, key, condition)) return false
          continue
        }
        if (allScalarOperators && !(key in row && isPlainObject(row[key]))) {
          if (!matchOperators(row[key], condition)) return false
          continue
        }
        // Direct to-one relation filter, e.g. `channel: { organizationId, OR: [...] }`.
        // Resolve the related row via the `<key>Id` foreign key and match the
        // whole condition against it. This is exactly how tenancy gates such as
        // `findThreadForUser` narrow by `channel.organizationId`.
        if (!this.matchDirectRelation(row, key, condition)) return false
        continue
      }
      if (!scalarEquals(row[key], condition)) return false
    }
    return true
  }

  /**
   * Resolve a to-one relation filter (`is`/`isNot`) via the conventional
   * `<relation>Id` foreign key. Used by scoping gates such as
   * `channelMember.findFirst({ where: { channel: { is: { organizationId } } } })`.
   * To-many filters (`some`/`none`/`every`) are not required by any gate under
   * test; if one appears we conservatively treat it as unsatisfied so a query
   * cannot silently widen.
   */
  private matchRelation(model: string, row: Row, key: string, condition: Row): boolean {
    if ('is' in condition || 'isNot' in condition) {
      const fk = row[`${key}Id`]
      const related = this.table(key).find((r) => r['id'] === fk) ?? null
      const isMatch = 'is' in condition
      const spec = (isMatch ? condition['is'] : condition['isNot']) as unknown
      if (spec === null) {
        return isMatch ? related === null : related !== null
      }
      const matched = related !== null && this.matchWhere(key, related, spec)
      return isMatch ? matched : !matched
    }
    const collection = this.collectionRelation(model, key)
    if (!collection) return false
    const related = this.table(collection.model).filter((candidate) =>
      candidate[collection.foreignKey] === row['id'],
    )
    if ('some' in condition) {
      return related.some((candidate) => this.matchWhere(collection.model, candidate, condition['some']))
    }
    if ('none' in condition) {
      return !related.some((candidate) => this.matchWhere(collection.model, candidate, condition['none']))
    }
    if ('every' in condition) {
      return related.every((candidate) => this.matchWhere(collection.model, candidate, condition['every']))
    }
    return false
  }

  private collectionRelation(
    model: string,
    key: string,
  ): { model: string; foreignKey: string } | null {
    const relations: Record<string, Record<string, { model: string; foreignKey: string }>> = {
      user: {
        organizationMembers: { model: 'organizationMember', foreignKey: 'userId' },
      },
      channel: {
        members: { model: 'channelMember', foreignKey: 'channelId' },
      },
      project: {
        members: { model: 'projectMember', foreignKey: 'projectId' },
      },
      knowledgeSpace: {
        members: { model: 'knowledgeSpaceMember', foreignKey: 'spaceId' },
      },
    }
    return relations[model]?.[key] ?? null
  }

  private matchDirectRelation(row: Row, key: string, spec: Row): boolean {
    const fk = row[`${key}Id`]
    const related = this.table(key).find((r) => r['id'] === fk) ?? null
    return related !== null && this.matchWhere(key, related, spec)
  }

  private find(model: string, where: unknown): Row | undefined {
    return this.table(model).find((row) => this.matchWhere(model, row, where))
  }

  private filter(model: string, where: unknown): Row[] {
    return this.table(model).filter((row) => this.matchWhere(model, row, where))
  }

  private delegate(model: string): Record<string, (args?: Row) => unknown> {
    const notFound = () =>
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        clientVersion: 'test',
        code: 'P2025',
      })
    return {
      findUnique: async (args?: Row) => this.find(model, args?.['where']) ?? null,
      findFirst: async (args?: Row) => this.find(model, args?.['where']) ?? null,
      findUniqueOrThrow: async (args?: Row) => {
        const row = this.find(model, args?.['where'])
        if (!row) throw notFound()
        return row
      },
      findFirstOrThrow: async (args?: Row) => {
        const row = this.find(model, args?.['where'])
        if (!row) throw notFound()
        return row
      },
      findMany: async (args?: Row) => {
        let rows = this.filter(model, args?.['where'])
        const take = args?.['take'] as number | undefined
        if (typeof take === 'number' && take >= 0) rows = rows.slice(0, take)
        return rows.map((r) => ({ ...r }))
      },
      count: async (args?: Row) => this.filter(model, args?.['where']).length,
      aggregate: async () => ({ _count: 0, _sum: {}, _avg: {}, _min: {}, _max: {} }),
      groupBy: async () => [],
      create: async (args?: Row) => {
        const data = { ...(args?.['data'] as Row) }
        this.table(model).push(data)
        return data
      },
      createMany: async (args?: Row) => {
        const data = args?.['data']
        const list = Array.isArray(data) ? data : [data]
        for (const item of list) this.table(model).push({ ...(item as Row) })
        return { count: list.length }
      },
      update: async (args?: Row) => {
        const row = this.find(model, args?.['where'])
        if (!row) throw notFound()
        Object.assign(row, args?.['data'] as Row)
        return { ...row }
      },
      updateMany: async (args?: Row) => {
        const rows = this.filter(model, args?.['where'])
        for (const row of rows) Object.assign(row, args?.['data'] as Row)
        return { count: rows.length }
      },
      upsert: async (args?: Row) => {
        const row = this.find(model, args?.['where'])
        if (row) {
          Object.assign(row, args?.['update'] as Row)
          return { ...row }
        }
        const created = { ...(args?.['create'] as Row) }
        this.table(model).push(created)
        return created
      },
      delete: async (args?: Row) => {
        const table = this.table(model)
        const index = table.findIndex((row) => this.matchWhere(model, row, args?.['where']))
        if (index < 0) throw notFound()
        const [removed] = table.splice(index, 1)
        return removed
      },
      deleteMany: async (args?: Row) => {
        const table = this.table(model)
        const survivors = table.filter((row) => !this.matchWhere(model, row, args?.['where']))
        const count = table.length - survivors.length
        table.length = 0
        table.push(...survivors)
        return { count }
      },
    }
  }

  /** Prisma-shaped client whose every model delegate is served by this store. */
  get client(): PrismaClient {
    const cache = new Map<string, unknown>()
    const store = this
    const handler: ProxyHandler<Row> = {
      get(_target, prop: string) {
        if (prop === 'then') return undefined
        if (prop === '$transaction') {
          return async (arg: unknown) => {
            if (typeof arg === 'function') {
              return (arg as (tx: PrismaClient) => unknown)(store.client)
            }
            if (Array.isArray(arg)) return Promise.all(arg)
            return arg
          }
        }
        if (prop === '$queryRaw' || prop === '$executeRaw' || prop === '$queryRawUnsafe') {
          return async () => []
        }
        if (prop === '$connect' || prop === '$disconnect') return async () => undefined
        if (!cache.has(prop)) cache.set(prop, store.delegate(prop))
        return cache.get(prop)
      },
    }
    return new Proxy({}, handler) as unknown as PrismaClient
  }
}
