/**
 * Renderer-owned, deterministic projections for categorical charts.
 *
 * The persisted source data remains the normalized dataset. These small views
 * aggregate only declared, numeric fields and do not accept formatter or
 * callback configuration from a widget author.
 */

import type { DashboardDataset } from '@nessie/schemas'

type CategorySort = 'value_desc' | 'value_asc' | 'category' | 'source'
export type CategoryChartRow = Record<string, number | string>

export const aggregateCategories = (
  dataset: DashboardDataset,
  categoryKey: string,
  valueKeys: string[],
): CategoryChartRow[] => {
  const grouped = new Map<string, CategoryChartRow>()
  for (const row of dataset.rows) {
    const category = String(row[categoryKey] ?? '—')
    const bucket = grouped.get(category) ?? { [categoryKey]: category }
    for (const valueKey of valueKeys) {
      const value = row[valueKey]
      if (typeof value === 'number') {
        bucket[valueKey] = Number(bucket[valueKey] ?? 0) + value
      }
    }
    grouped.set(category, bucket)
  }
  return [...grouped.values()]
}

export const sortCategories = (
  rows: CategoryChartRow[],
  categoryKey: string,
  primaryValueKey: string,
  sort: CategorySort,
): CategoryChartRow[] => {
  if (sort === 'source') return rows

  return [...rows].sort((left, right) => {
    if (sort === 'category') {
      return String(left[categoryKey] ?? '').localeCompare(String(right[categoryKey] ?? ''))
    }
    const leftValue = Number(left[primaryValueKey] ?? 0)
    const rightValue = Number(right[primaryValueKey] ?? 0)
    return sort === 'value_asc' ? leftValue - rightValue : rightValue - leftValue
  })
}
