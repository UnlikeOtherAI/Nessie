import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IntegratedProductResponse } from '../lib/api-client'
import {
  AgentConnectorSection,
  mcpCatalogHref,
  mcpConnectorClass,
  mcpConnectorLabel,
} from '../components/features/integrations/AgentConnectorSection'
import { BuildMeProjectPanel } from '../components/features/integrations/BuildMeProjectPanel'
import { DeepTestSecurityPanel } from '../components/features/integrations/DeepTestSecurityPanel'
import { DeepWaterResearchPanel } from '../components/features/integrations/DeepWaterResearchPanel'
import { ManifestPanel } from '../components/features/integrations/ManifestPanel'
import {
  ProductOperationsSection,
  productUsageBadgeLabel,
} from '../components/features/integrations/ProductOperationsSection'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import {
  useIntegratedProducts,
  useIntegrationPluginManifest,
  useSetProductTeamEnablement,
} from '../facades/integrations/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAuthSession } from '../providers/AuthSessionProvider'

type SurfacePlan = {
  nativePage: string
  chatCards: string
  controls: string
  agentAccess: string
  artifacts: string
  nextStep: string
}

const surfacePlans: Record<string, SurfacePlan> = {
  'deep-water': {
    nativePage: 'Research workspace with runs, source review, spend, and Knowledge import.',
    chatCards: 'Progress, result, source, and cost cards rendered from message metadata.',
    controls: 'Depth, chapter detail, search quality, recency, output language, and artifact destination.',
    agentAccess: 'Approved MCP tools for create, poll, list, and research scoping conversations.',
    artifacts: 'Reports and evidence land in Knowledge; file blobs go through FileService.',
    nextStep: 'Install and approve the OAuth MCP connector, then add the native run wrapper.',
  },
  deeptest: {
    nativePage: 'Link-out plus local runner status, safe report history, and review profile state.',
    chatCards: 'Security review summary cards with content-minimized status and report links.',
    controls: 'Review profile, local runner target, share-safe import, and disclosure boundary.',
    agentAccess: 'Approved MCP wrapper around deeptest_review and safe status/report retrieval.',
    artifacts: 'Share-safe reports can enter Knowledge; raw target material stays local by default.',
    nextStep: 'Install the local MCP runner, approve safe tools, and preserve the privacy boundary.',
  },
  buildme: {
    nativePage: 'Link-out now; project-board source pairing later once BuildMe exposes board APIs.',
    chatCards: 'Project handoff and board sync cards once external board IDs are paired.',
    controls: 'Column mapping, assignee mapping, sync mode, and conflict policy.',
    agentAccess: 'MCP/API connector after the BuildMe project-board contract is published.',
    artifacts: 'Project specs can link into Nessie project docs without duplicating board state.',
    nextStep: 'Define and ship the BuildMe board API before native board rendering.',
  },
}

const categoryLabels: Record<IntegratedProductResponse['category'], string> = {
  development: 'Development',
  project_management: 'Project management',
  research: 'Research',
  security: 'Security',
}

const installLabels: Record<IntegratedProductResponse['defaultInstallState'], string> = {
  installable: 'Installable',
  link_only: 'Link only',
  native: 'Native',
}

const healthLabels: Record<IntegratedProductResponse['healthStatus'], string> = {
  degraded: 'Degraded',
  healthy: 'Healthy',
  setup_required: 'Setup required',
  unknown: 'Unknown',
  unreachable: 'Unreachable',
}

const statusClass = (status: IntegratedProductResponse['healthStatus']): string =>
  [
    'inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold',
    status === 'healthy'
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : status === 'degraded' || status === 'setup_required'
        ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
        : status === 'unreachable'
          ? 'bg-[var(--danger-soft)] text-[var(--danger-text)]'
          : 'bg-[var(--overlay)] text-[var(--tx2)]',
  ].join(' ')

const productAccent = (slug: string): string => {
  if (slug === 'deep-water') return '#0f766e'
  if (slug === 'deeptest') return '#991b1b'
  if (slug === 'buildme') return '#4338ca'
  return '#475569'
}

const ProductGlyph = ({ product }: { product: IntegratedProductResponse }) => (
  <span
    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
    style={{ backgroundColor: productAccent(product.slug) }}
  >
    {product.name.slice(0, 2).toUpperCase()}
  </span>
)

const LaunchIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const accountLabel = (product: IntegratedProductResponse): string => {
  if (product.accountLink?.status === 'linked') return 'Account linked'
  if (product.accountLink?.status === 'error') return 'Account error'
  if (product.accountLink?.status === 'revoked') return 'Revoked'
  if (product.authMode === 'local_mcp') return 'Local runner pending'
  if (product.authMode === 'uoa_sso') return 'UOA link pending'
  return 'Auth setup pending'
}

const teamEnablementLabel = (product: IntegratedProductResponse): string =>
  product.teamEnablement?.enabled ? 'Team enabled' : 'Team disabled'

const capabilityLabel = (value: string): string =>
  value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const ProductRow = ({
  active,
  onSelect,
  product,
}: {
  active: boolean
  onSelect: () => void
  product: IntegratedProductResponse
}) => (
  <button
    className={[
      'admin-card w-full p-3 text-left transition',
      active ? 'ring-2 ring-[var(--accent)]' : 'hover:bg-[var(--overlay-weak)]',
    ].join(' ')}
    onClick={onSelect}
    type="button"
  >
    <div className="flex min-w-0 gap-3">
      <ProductGlyph product={product} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-[var(--tx)]">{product.name}</h3>
          <span className={statusClass(product.healthStatus)}>
            {healthLabels[product.healthStatus]}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--tx3)]">{product.summary}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
            {installLabels[product.defaultInstallState]}
          </span>
          <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
            {accountLabel(product)}
          </span>
          <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
            {teamEnablementLabel(product)}
          </span>
          <span className={mcpConnectorClass(product)}>{mcpConnectorLabel(product)}</span>
          <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
            {productUsageBadgeLabel(product)}
          </span>
        </div>
      </div>
    </div>
  </button>
)

const SurfaceRow = ({ label, value }: { label: string; value: string }) => (
  <div className="border-t border-[var(--sep)] py-3 first:border-t-0 first:pt-0">
    <div className="text-xs font-semibold uppercase text-[var(--tx3)]">{label}</div>
    <div className="mt-1 text-sm leading-6 text-[var(--tx)]">{value}</div>
  </div>
)

const TeamAccessSection = ({
  isOwner,
  product,
}: {
  isOwner: boolean
  product: IntegratedProductResponse
}) => {
  const setTeamEnablement = useSetProductTeamEnablement()
  const enabled = product.teamEnablement?.enabled ?? false
  const isToggling =
    setTeamEnablement.isPending && setTeamEnablement.variables?.productSlug === product.slug
  const externalTeamId = product.teamEnablement?.externalTeamId ?? product.accountLink?.activeTeamId
  const externalOrgId = product.teamEnablement?.externalOrgId ?? product.accountLink?.activeOrgId

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Team access</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            {enabled ? 'Enabled for the active team.' : 'Not enabled for the active team.'}
          </p>
        </div>
        <label className="inline-flex min-h-9 items-center gap-2 rounded border border-[var(--sep)] px-3 text-sm text-[var(--tx)]">
          <input
            checked={enabled}
            className="h-4 w-4 accent-[var(--accent)]"
            disabled={!isOwner || isToggling}
            onChange={() =>
              setTeamEnablement.mutate({
                enabled: !enabled,
                productSlug: product.slug,
              })
            }
            type="checkbox"
          />
          <span>{isToggling ? 'Saving...' : 'Enabled'}</span>
        </label>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Account</div>
          <div className="mt-1 text-sm text-[var(--tx)]">{accountLabel(product)}</div>
        </div>
        <div className="rounded border border-[var(--sep)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">UOA workspace</div>
          <div className="mt-1 truncate text-sm text-[var(--tx)]">
            {externalTeamId ? `${externalOrgId ?? 'org'} / ${externalTeamId}` : 'Not projected yet'}
          </div>
        </div>
      </div>
      {!isOwner ? (
        <p className="mt-2 text-xs text-[var(--tx3)]">Owner access required to change team access.</p>
      ) : null}
      {setTeamEnablement.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {setTeamEnablement.error instanceof Error
            ? setTeamEnablement.error.message
            : 'Failed to update team access.'}
        </p>
      ) : null}
    </section>
  )
}

const ProductDetail = ({
  onBack,
  product,
  showBack,
}: {
  onBack: () => void
  product: IntegratedProductResponse
  showBack: boolean
}) => {
  const { me } = useAuthSession()
  const manifestQuery = useIntegrationPluginManifest(product.slug)
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const plan = surfacePlans[product.slug] ?? {
    nativePage: 'Custom product page registered from the integration manifest.',
    chatCards: 'Cards rendered from message metadata when agents run product work.',
    controls: 'Product-specific controls declared by the plugin manifest.',
    agentAccess: 'Approved MCP tools exposed through the existing tool registry.',
    artifacts: 'Durable artifacts stored through Knowledge and FileService.',
    nextStep: 'Publish the product manifest and MCP catalog entry.',
  }

  return (
    <ColumnBrowserColumn onBack={onBack} showBack={showBack} title={product.name}>
      <div className="grid max-w-4xl gap-4">
        <section className="grid gap-3 border-b border-[var(--sep)] pb-4">
          <div className="flex items-start gap-3">
            <ProductGlyph product={product} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--tx)]">{product.name}</h2>
                <span className={statusClass(product.healthStatus)}>
                  {healthLabels[product.healthStatus]}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">{product.summary}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]">
              {categoryLabels[product.category]}
            </span>
            <span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]">
              {installLabels[product.defaultInstallState]}
            </span>
            <span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]">
              {accountLabel(product)}
            </span>
            <span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]">
              {teamEnablementLabel(product)}
            </span>
            <span className={mcpConnectorClass(product)}>{mcpConnectorLabel(product)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {product.launchUrl ? (
              <a
                className="admin-button admin-button-primary gap-1.5 text-xs"
                href={product.launchUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open <LaunchIcon />
              </a>
            ) : null}
            {product.mcpCatalogEntryId ? (
              <Link
                className="admin-button admin-button-secondary text-xs"
                to={mcpCatalogHref(product)}
              >
                MCP store
              </Link>
            ) : null}
          </div>
        </section>

        <TeamAccessSection isOwner={isOwner} product={product} />
        <AgentConnectorSection product={product} />
        <ProductOperationsSection product={product} />
        {product.slug === 'buildme' ? <BuildMeProjectPanel product={product} /> : null}
        {product.slug === 'deep-water' ? <DeepWaterResearchPanel product={product} /> : null}
        {product.slug === 'deeptest' ? <DeepTestSecurityPanel product={product} /> : null}

        <section>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Interface surfaces</h3>
          <div className="mt-3">
            <SurfaceRow label="Native page" value={plan.nativePage} />
            <SurfaceRow label="Chat cards" value={plan.chatCards} />
            <SurfaceRow label="Custom controls" value={plan.controls} />
            <SurfaceRow label="Agent access" value={plan.agentAccess} />
            <SurfaceRow label="Artifacts" value={plan.artifacts} />
          </div>
        </section>

        <ManifestPanel loading={manifestQuery.isLoading} manifest={manifestQuery.data} />

        <section className="border-t border-[var(--sep)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--tx)]">Capabilities</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {product.capabilities.map((capability) => (
              <span
                className="rounded bg-[var(--overlay)] px-2 py-1 text-xs text-[var(--tx2)]"
                key={capability}
              >
                {capabilityLabel(capability)}
              </span>
            ))}
          </div>
        </section>

        <section className="border-t border-[var(--sep)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--tx)]">Next step</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            {product.setupHint ?? plan.nextStep}
          </p>
        </section>
      </div>
    </ColumnBrowserColumn>
  )
}

export const IntegrationsPage = () => {
  const productsQuery = useIntegratedProducts()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [selectedSlug, setSelectedSlug] = useState<string>()
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data])
  const selectedProduct = useMemo(
    () => products.find((product) => product.slug === selectedSlug) ?? products[0] ?? null,
    [products, selectedSlug],
  )

  const listBody = productsQuery.isLoading ? (
    <div className="py-8 text-center text-sm text-[var(--tx3)]">Loading integrations...</div>
  ) : productsQuery.isError ? (
    <div className="py-8 text-center text-sm text-[var(--danger-text)]">
      Failed to load integrations.{' '}
      <button className="underline" onClick={() => void productsQuery.refetch()} type="button">
        Retry
      </button>
    </div>
  ) : products.length === 0 ? (
    <div className="py-8 text-center text-sm text-[var(--tx3)]">No integrations registered.</div>
  ) : (
    <div className="grid gap-3">
      {products.map((product) => (
        <ProductRow
          active={selectedProduct?.slug === product.slug}
          key={product.slug}
          onSelect={() => {
            setSelectedSlug(product.slug)
            setMobileDetailOpen(true)
          }}
          product={product}
        />
      ))}
    </div>
  )

  const columns = [
    <ColumnBrowserColumn key="list" title={`Integrations (${products.length})`}>
      {listBody}
    </ColumnBrowserColumn>,
  ]

  if (selectedProduct) {
    columns.push(
      <ProductDetail
        key={selectedProduct.slug}
        onBack={() => setMobileDetailOpen(false)}
        product={selectedProduct}
        showBack={isMobile}
      />,
    )
  }

  return (
    <ColumnBrowserViewport
      activeColumn={isMobile && mobileDetailOpen ? 1 : 0}
      columns={columns}
    />
  )
}
