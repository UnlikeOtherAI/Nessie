// Dashboard cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

// Nested so the family rule holds and `dashboardKeys.all` reaches it — nothing
// more. A widget's own mutations (layout, removal, lock) invalidate
// `detail(dashboardId)`, which does NOT reach this key, and that is unchanged
// from before: widget data is refetched by its own reads, not by editing the
// dashboard around it. Every rendered view of one widget spreads this prefix,
// so the compact and full reads share an invalidation.
const dashboardWidgetDataKey = (widgetId: string) =>
  ['dashboards', 'widget-data', widgetId] as const

export const dashboardKeys = {
  all: ['dashboards'] as const,
  detail: (dashboardId?: string) => ['dashboards', dashboardId] as const,
  embed: (embedId: string) => ['dashboard-embed', embedId] as const,
  // `querySuffix` is the request's own query string: a filtered list and a
  // compact widget render are different responses and cannot share an entry.
  // The 'list' segment keeps the unfiltered list off `detail`'s shape: both
  // took one free segment under the root, so `list('')` and a disabled
  // `detail(undefined)` used to be the same cache entry with two response types.
  list: (querySuffix: string) => ['dashboards', 'list', querySuffix] as const,
  sourceNotes: (dashboardId?: string) =>
    [...dashboardKeys.detail(dashboardId), 'source-notes'] as const,
  sources: ['dashboard-sources'] as const,
  versions: (dashboardId: string) => ['dashboards', dashboardId, 'versions'] as const,
  widgetDataAll: ['dashboards', 'widget-data'] as const,
  widgetData: dashboardWidgetDataKey,
  widgetDataView: (widgetId: string, querySuffix: string) =>
    [...dashboardWidgetDataKey(widgetId), querySuffix] as const,
}
