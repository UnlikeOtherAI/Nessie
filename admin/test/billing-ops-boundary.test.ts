import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('customer credits page cannot import Nessie operational billing logic', () => {
  const source = readSource('../src/pages/TokenUsagePage.tsx')

  assert.match(source, /UoaBillingCreditsPanel/)
  assert.match(source, /UoaBillingRecurringAddonsPanel/)
  assert.match(source, /UoaBillingStatementPanel/)
  assert.doesNotMatch(source, /\/api\/ledger\//)
  assert.doesNotMatch(source, /BudgetManager/)
  assert.doesNotMatch(source, /PricingManager/)
  assert.doesNotMatch(source, /Estimated Cost/)
  assert.doesNotMatch(source, /Monthly Projection/)
})

test('local calculations remain on the owner-only operations surface', () => {
  const telemetry = readSource('../src/pages/OperationalTelemetryPage.tsx')
  const router = readSource('../src/router.tsx')
  const navigation = readSource(
    '../src/layouts/admin-shell/AdminSidebarNav.tsx',
  )

  // The refusal sentence moved into the shared <OwnerGate>; what this line
  // pins is that the page is still owner-gated, not where the words live.
  assert.match(telemetry, /<OwnerGate>/)
  assert.match(telemetry, /\/api\/ledger\/tokens\/summary/)
  assert.match(telemetry, /BudgetManager/)
  assert.match(telemetry, /PricingManager/)
  assert.match(router, /path: '\/ops\/usage'/)
  assert.match(
    navigation,
    /path: '\/ops\/usage',[\s\S]{0,120}label: 'Operational usage',[\s\S]{0,120}ownerOnly: true/,
  )
})

test('integration product surfaces do not expose local usage summaries', () => {
  const route = readSource('../../api/src/routes/integrations/products.ts')
  const rows = readSource('../../api/src/services/integration-product-rows.ts')
  const schema = readSource('../../packages/schemas/src/integrations.ts')
  const service = readSource('../../api/src/services/integrations.ts')
  const integrations = readSource('../src/pages/IntegrationsPage.tsx')
  const buildMe = readSource(
    '../src/components/features/integrations/BuildMeProjectPanel.tsx',
  )
  const deepTest = readSource(
    '../src/components/features/integrations/DeepTestSecurityPanel.tsx',
  )

  assert.doesNotMatch(route, /usageSummary/)
  assert.doesNotMatch(rows, /usageSummary|product_usage_/)
  assert.doesNotMatch(schema, /ProductUsageSummaryRecord|usageSummary/)
  assert.doesNotMatch(service, /connector_usage_events|product_usage/)
  assert.doesNotMatch(integrations, /usageSummary/)
  assert.doesNotMatch(buildMe, /usageSummary/)
  assert.doesNotMatch(deepTest, /usageSummary/)
})
